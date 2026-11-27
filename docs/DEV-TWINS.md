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

Guest SMS (confirmation, reminder, cancellation) is off by default for every restaurant, so the seed's `notifications` step switches it on in a twin (a value already set, on or off, stays). Press Refresh dev twin on an older twin to get it.

## Every guest feature on (owner 2026-11-24)

A twin has every guest-facing feature in dev, whatever prod's plan is, so a
dev site can test everything: reservations, ordering, catering, marketing,
gift cards, waitlist, events and the phone assistant (100 minutes a month).
`devtwin.TWIN_FEATURES` and `TWIN_LIMITS`, applied as plan overrides:

- on the mirror (`site._create_mirror` passes them to `create_tenant`);
- on every plan change of a twin (`tenants.apply_plan`, so Change plan or
  the daily Free switch never turns them off);
- by the seed's first step, `features` (older twins, a Refresh).

Only in dev (`ENVIRONMENT` is exactly `dev`, `DEV_TWIN_FUNCTION_PREFIX` is
set, and the customer is a twin; a missing or misnamed `ENVIRONMENT` counts
as prod, so prod's real Anar never matches `LEGACY_TWINS`); a dev test
customer keeps its plan. Dev billing runs in the Stripe sandbox and
the price is fixed per plan, so this costs nothing.

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
once (or **Refresh all dev twins**). The seed invites the team login, makes
it the contact owner, replaces the restaurant's seller details on the dev
profile with fake ones (step legal) and replaces the location's real
contact data (step details). A login the old mirror made for the
restaurant's own address stays until an operator removes it on the Users
tab.

## The seed

`booqy-console/api/src/app/devtwin.py`. It waits until onboarding has made
the tenant active, then runs each step, looking first and adding only what
is missing. Running it again duplicates nothing and keeps a developer's
changes (dishes and categories are matched by name). Four steps also
replace values:

- features: a guest-facing feature that is off goes back on;
- details: contact data that is not fake (below), on every location;
- catering: catering a developer switched off goes back on; only its empty
  settings get the seed's, the developer's own minimum, lead times, bands,
  pickup or delivery and terms stay;
- legal: until the profile carries the test org. number, its seller details
  are the restaurant's (an older mirror's copy) and all of them go;
  afterwards only an email that is not a team address and a phone outside
  the fiction range are replaced.

One seed per twin at a time: the press writes `devTwin` queued only when no
seed is queued or running (a conditional write, so two quick presses or
Refresh plus Refresh all start one). A seed queued or running for more than
10 minutes (`STALE_MINUTES`; the Lambda stops after 300 s) counts as dead
and may be started again.

| Step | What | Through |
|---|---|---|
| features | every guest-facing feature on, phone assistant 100 minutes (above); the admin's functions keep a tenant row for 60 s, so after turning a feature on the first guest step waits that out once (`FEATURES_SETTLE_SECONDS`) | console (tenant profile) |
| owner | team login `aws+<slug>@ithjalparna.se` is an owner and the contact owner | console (Users) |
| stripe | the shared Stripe TEST-mode account `dev_twin_stripe_account_id`, ready | console (Stripe) |
| location | the oldest location guests can reach (as application `shared/tenant.py` `tenant_of_location`: a `tenantId` matching PK, its own `locationId`, no other tenant with that id in `byLocationId`); a row that only lacks `tenantId` or `locationId` gets it; when none can be reached, a fresh one (Testgatan 1, a fiction phone), or the step says why (the plan's location limit) | console (Locations) |
| details | opening hours, avvikande dagar (Christmas Eve, New Year's Eve, a private party), booking length, late guests, max party online, card guarantee (6 or more, 200 kr no-show), online ordering (pickup), the time zone Europe/Stockholm when the row has none; fake contact data on every location (below; a row guests can't reach, which create-location answers 404 for, through the console's own location edit) | create-location, console (Locations) |
| menu | categories Dagens lunch, Förrätter, Varmrätter, Efterrätter, Drycker and 13 dishes and drinks | get-menu, manage-menu |
| layout | Matsal with 8 tables, published and active | layout functions |
| catering | settings (pickup and delivery up to 25 km in two bands, from 15 guests, lead times 5, 8 and 10 days, cleaning fee 300 kr, simple acceptance, Swedish test terms, notifications to the team login and the fiction phone); up to 12 dishes from the twin's menu (not Dagens lunch, drinks or alcohol) with EU allergen codes; allergens filled in on a dish that has none when the menu or the seed knows them; one package (Testpaket trerätters); one discount tier (10 % from 50 portions) | catering-settings, catering-discount-tiers |
| giftCards | gift cards on: 250, 500, 1000 kr or an own amount of 100 to 5000 kr, valid 24 months | gift-cards |
| waitlist | waitlist on, guests may join from the site (`location.waitlist.publicJoin`) | waitlist |
| events | one published "Testkväll" 30 days ahead (not on Christmas or New Year), 19:00 to 23:00, 40 places, tickets Entré 150 kr (25 % VAT) and Entré med middag 495 kr (12 % VAT); a new one once the last has passed. Only the seed's own event counts (eventId `testkvall<YYYYMMDD>`); a developer's events, drafts called Testkväll included, are never published or changed | events-tickets |
| legal | seller details on the profile (receipts, catering offers, legal pages): `<name> Test AB`, org. number 402000-0008, VAT SE402000000801, the team login, the fiction phone, Testgatan 1, 111 22 Stockholm; a reply-to or billing email that is not a team address becomes the team login. The org. number has a valid check digit and first digit 4, a group Skatteverket's numbering (SKV 709: 1, 2, 3, 5 to 9) gives no organisation | console (tenant profile) |
| printers | a simulated kitchen printer (dev only, prints show in the console) | console (Printers) |
| staff | `aws+<slug>-personal@ithjalparna.se` as staff | console (Users), manage-user |
| dpa | the current personuppgiftsbiträdesavtal accepted | tenant-account |
| google | Google profile skipped (optional step) | google-business |
| phone | assistant named, always on, simulated number, forwarding and test call done | phone-agent |

Fake contact data (DATA-RULES.md, "Never copied"): the location's phone is
replaced when it lies outside the PTS fiction range (+46701740605 to
+46701740699, +46313900600 to 699, +46846500400 to 499, +46406280400 to 499,
+46980319200 to 299) or equals prod's public number (read from prod's public
site config when `dev_twin_prod_api_url` is set); so is the catering
`notifyPhone` (in the catering step, so a failing catering call never holds
up the location's details). The location's email is replaced when it is not
a team address: `aws+<anything>@ithjalparna.se` or `aws@ithjalparna.se`
(the owner template's plus form), never any other address at that domain,
which is a person's. The address is replaced when it is not Testgatan,
unless it came from prod's public content (the content copy's location step
ran, first location only): only a legacy twin's real-looking address goes.
All of this on every location of the twin.

Admin's Kom igång then shows every step done. The run's progress is on the
tenant profile (`devTwin`: status queued, running, ready, partial or failed,
one line per step) and on the card in the dev console. A failed step does
not stop the others; fix the cause and press Refresh.

## Refresh all dev twins

After a deploy that adds seed steps, press **Refresh all dev twins** on any
twin's Dev twin card (`POST /platform/tenants/{tenantId}/dev-twin` with
`{"all": true}`, the existing route; dev only, 404 in prod). It queues the
seed for every twin that is active or still onboarding (at most 50 at a
time), leaves a twin whose seed is already running alone, never touches dev
test customers, and answers `{queued: [slug], skipped: [{slug, reason}]}`,
shown on the card. Each seed adds what is missing and replaces only what
the four steps above replace.

Mail a twin's guest flows send through the notification function in dev
(catering offers, gift card codes, tickets, booking mail) is saved to the
console's Mail outbox instead of going through SES (`mail_outbox = true` in
dev.tfvars, never in prod); SMS are copied there and still sent. Cognito's
invitations to the team logins are not part of it (below).

The admin's functions are invoked directly as an owner of the twin
(application `shared/console_invoke.py`, operator `dev-twin`, audit fields
say `operator:dev-twin`). Those functions accept such a call **only where
`ENVIRONMENT` is `dev`** (`dev_twin_entry`; prod, or a Lambda without the
variable, refuses); prod keeps the Users tab and nothing more. The
`dev-platform-tenants` role may invoke them in dev only (infrastructure
`security/iam/platform-tenants`, managed policy
`dev-platform-tenants-dev-twins`, allowlist
`dev_twin_function_arns` in `config.tf`: the Kom igång functions plus
catering-settings, catering-discount-tiers, gift-cards, waitlist and
events-tickets; empty in prod).

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
