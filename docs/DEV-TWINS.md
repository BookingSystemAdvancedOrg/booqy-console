# Dev twins

How dev twins work in Booqy. **The rules** (dev = the twin, prod = the real
restaurant; what is copied and what never is; twins versus dev test
customers; collisions; deleting) are in one place only:
[BooqyCustomers/site-template `docs/DATA-RULES.md`](https://github.com/BooqyCustomers/site-template/blob/dev/docs/DATA-RULES.md).
This page is the implementation.

Every real customer has a twin in the dev account (877653167825): same name,
slug and plan, owned by Booqy (owner login `aws+<slug>@ithjalparna.se`), with test
data in every Kom igång step, marked `twinOf: {env: "prod", tenantId}`. A
customer created in the dev console is a dev test customer (`siteKind
"test"`) and never becomes a twin.

## How a twin is made

```
prod console: New customer
  └─ tenant-onboarding ─> site-repo provision (prod)
        └─ assume dev booqy-sites-prod-link ─> dev platform-tenants {"siteTask": "mirror", name, slug, planId}
              ├─ create the dev tenant (or adopt the one with that slug)
              │    owner login DEV_TWIN_OWNER_EMAIL with the slug (aws+<slug>@ithjalparna.se)
              └─ async {"twinTask"} through the live alias ─> the seed (below)

dev console: customer, Overview, Dev twin, "Create dev twin" / "Refresh dev twin"
  └─ POST /platform/tenants/{tenantId}/dev-twin ─> the same seed
```

The prod to dev path is the existing site link (no new cross-account
trust): `booqy-sites-prod-link` in dev may invoke dev `platform-tenants` with
a site task and nothing else. Prod's site-repo sends only name, slug and
plan; dev ignores anything else an older prod build still sends.

## Collisions (DATA-RULES.md, "No collisions")

`site.site_task` "mirror" checks the dev customer that holds the slug
(`devtwin.clash`): a dev test customer, another prod customer's twin, or a
dev customer that is not a twin is never merged or written over. The answer
to prod is an error with the operator's message, and the dev customer gets
`twinClash` (shown on it in Booqy Console Dev) and an audit row. A twin of
the same prod customer is adopted and marked. Anar's manual dev tenant
counts as Anar's twin (`LEGACY_TWINS`).

A new customer in the dev console may not take a slug a prod customer uses
(`tenants.create_tenant` asks prod's public site config,
`<slug>.booqy.se`; a prod API that can't be reached never blocks).

Prod offboarding (site task "archive") only sets `twinProdOffboardedAt` on
the twin (and removes the archived repo's dev deploy role, as before).
Offboarding or deleting a twin is an operator's action in Booqy Console Dev
and never reaches prod.

## Public content from prod

`devtwin_content.py`. When the restaurant finishes its Kom igång setup in
prod, `Tenant.SetupCompleted` (source `booqy.tenant-setup`) matches the prod
rule `prod-twin-content` (infrastructure `dev-twins.tf`), which invokes prod
site-repo `{action: twinContent, tenantId}`; site-repo sends dev the site task
`{action: content, slug, prodTenantId}`. "Copy public content now" on the
twin's Dev twin card does the same on demand
(`POST /platform/tenants/{tenantId}/dev-twin/content`).

Dev then reads prod's **public** API itself (`dev_twin_prod_api_url`, what a
guest's browser reads; never a prod token or table): site config, the
public menu, the active layout, and the dish photos on prod's public CDN
(`dev_twin_prod_image_url`). It writes them through the admin's own
functions as the twin's owner:

| Step | Copied | Never |
|---|---|---|
| source | checks prod's restaurant is this twin's (`twinOf`) | |
| location | name, address, hours, avvikande dagar, booking length, late guests, max party online, card guarantee and ordering policy | phone number, email, Stripe |
| menu | categories in prod's order, dishes by name (text, price, allergens, options, alcohol, photo); a dish prod lacks is removed | |
| layout | prod's active layout with the twin's own ids, published and activated (again only when prod's changed) | bookings |

Photos are downloaded from prod's CDN and uploaded through the twin's own
presigned URL (pre-signed-url), once per photo. Progress is
`devTwinContent` on the twin's profile and on the card.

A customer created in prod before dev twins (its dev tenant was mirrored
with the restaurant's owner address and details): press **Refresh dev twin**
once. The seed invites the team login, makes it the contact owner and
removes the restaurant's details from the dev profile. A login the old
mirror made for the restaurant's own address stays until an operator
removes it on the Users tab.

## The seed

`booqy-console/api/src/app/devtwin.py`. It waits until onboarding has made
the tenant active, then runs each step, looking first and adding only what
is missing. Running it again duplicates nothing and keeps a developer's
changes (dishes and categories are matched by name).

| Step | What | Through |
|---|---|---|
| owner | team login `aws+<slug>@ithjalparna.se` is an owner and the contact owner | console (Users) |
| stripe | the shared Stripe TEST-mode account `dev_twin_stripe_account_id`, ready | console (Stripe) |
| location | one location, address Testgatan 1, phone in the PTS fiction range | console (Locations) |
| details | opening hours, avvikande dagar (Christmas Eve, New Year's Eve, a private party), booking length, late guests, max party online, card guarantee (6 or more, 200 kr no-show), online ordering (pickup) | create-location |
| menu | categories Dagens lunch, Förrätter, Varmrätter, Efterrätter, Drycker and 13 dishes and drinks | get-menu, manage-menu |
| layout | Matsal with 8 tables, published and active | layout functions |
| printers | a simulated kitchen printer (dev only, prints show in the console) | console (Printers) |
| staff | `aws+<slug>-personal@ithjalparna.se` as staff | console (Users), manage-user |
| dpa | the current personuppgiftsbiträdesavtal accepted | tenant-account |
| google | Google profile skipped (optional step) | google-business |
| phone | assistant named, always on, simulated number, forwarding and test call done | phone-agent |

Admin's Kom igång then shows every step done. The run's progress is on the
tenant profile (`devTwin`: status queued, running, ready, partial or failed,
one line per step) and on the card in the dev console. A failed step does
not stop the others; fix the cause and press Refresh.

The admin's functions are invoked directly as an owner of the twin
(application `shared/console_invoke.py`, operator `dev-twin`, audit fields
say `operator:dev-twin`). Those functions accept such a call **only outside
prod** (`dev_twin_entry`); prod keeps the Users tab and nothing more. The
`dev-platform-tenants` role may invoke them in dev only (infrastructure
`security/iam/platform-tenants`, policy `dev-twins`).

## Settings (infrastructure dev.tfvars)

| Variable | What |
|---|---|
| `dev_twin_owner_email` | the twin's owner login, `{slug}` becomes the slug; a Booqy team address, never the restaurant's |
| `dev_twin_stripe_account_id` | a fully onboarded Stripe TEST-mode connected account every twin takes payments with (an id, not a secret) |
| `dev_twin_prod_api_url`, `dev_twin_prod_image_url` | prod's public API and menu image CDN (what any guest reads) |

Off in prod: the variables are empty there, the route answers 404 and the
functions refuse console calls.

## Signing in to a twin

The owner login is `aws+<slug>@ithjalparna.se` (staff: `aws+<slug>-personal@ithjalparna.se`),
owner's choice 2026-11-18; all of them land in the team's `aws@ithjalparna.se`
mailbox. The invitation (temporary password) and Glömt lösenord come from
the dev tenant pool's Cognito default sender (`cognito_invites_via_ses =
false` in dev), not from SES, so the dev SES sandbox does not apply and
nothing has to be verified. Cognito's default sender allows 50 emails a day
per account. If the pool later sends through SES while dev SES is still in
the sandbox, verify the domain `ithjalparna.se` in dev SES first, or the
mail is rejected. Give the login to the site's developer when they need to
change the twin's data.
