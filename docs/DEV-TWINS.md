# Dev twins

Every real Booqy customer has a **dev twin**: the same restaurant in the dev
environment (account 877653167825), with the same name and slug, owned by
Booqy and fully set up with test data. Whoever builds the restaurant's
website (`BooqyCustomers/site-<slug>`, branch `dev`, live on
`https://<slug>.dev.booqy.se`) builds against the twin.

- **dev = the twin.** Booqy's own test restaurant. Developers and Booqy set it
  up and change it as they need.
- **prod = the real restaurant.** The restaurant sets up its 9 Kom igång steps
  in production Booqy Admin. Nobody touches that for testing.
- Never copy production personal data to dev. Only **name, slug and plan**
  cross; the owner, contact, company and address details stay in prod.

## How a twin is made

```
prod console: New customer
  └─ tenant-onboarding ─> site-repo provision (prod)
        └─ assume dev booqy-sites-prod-link ─> dev platform-tenants {"siteTask": "mirror", name, slug, planId}
              ├─ create the dev tenant (or adopt the one with that slug)
              │    owner login DEV_TWIN_OWNER_EMAIL with the slug (dev+<slug>@booqy.se)
              └─ async {"twinTask"} through the live alias ─> the seed (below)

dev console: customer, Overview, Dev twin, "Create dev twin" / "Refresh dev twin"
  └─ POST /platform/tenants/{tenantId}/dev-twin ─> the same seed
```

The prod to dev path is the existing site link (no new cross-account
trust): `booqy-sites-prod-link` in dev may invoke dev `platform-tenants` with
a site task and nothing else. Prod's site-repo sends only name, slug and
plan; dev ignores anything else an older prod build still sends.

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
| owner | team login `dev+<slug>@booqy.se` is an owner and the contact owner | console (Users) |
| stripe | the shared Stripe TEST-mode account `dev_twin_stripe_account_id`, ready | console (Stripe) |
| location | one location, address Testgatan 1, phone in the PTS fiction range | console (Locations) |
| details | opening hours, avvikande dagar (Christmas Eve, New Year's Eve, a private party), booking length, late guests, max party online, card guarantee (6 or more, 200 kr no-show), online ordering (pickup) | create-location |
| menu | categories Dagens lunch, Förrätter, Varmrätter, Efterrätter, Drycker and 13 dishes and drinks | get-menu, manage-menu |
| layout | Matsal with 8 tables, published and active | layout functions |
| printers | a simulated kitchen printer (dev only, prints show in the console) | console (Printers) |
| staff | `dev+<slug>-personal@booqy.se` as staff | console (Users), manage-user |
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

Off in prod: the variables are empty there, the route answers 404 and the
functions refuse console calls.

## Signing in to a twin

The team login gets Booqy's invitation email. Otherwise: dev Booqy Admin,
Glömt lösenord, with `dev+<slug>@booqy.se`. Give the login to the site's
developer when they need to change the twin's data.
