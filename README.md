# Booqy Console

The operator console for the restaurant SaaS - only the platform's owners
(you) can sign in. Create, edit and offboard customers (tenants), manage
their locations, owners, plan, Stripe connected account and domains.

```
sbs-admin/
├── web/   React + Vite + TypeScript SPA (S3 + CloudFront, ops.<platform domain>)
└── api/   platform-tenants Lambda (Python 3.13, container image) - every /platform/* route
```

The AWS resources (bucket, distribution, Lambda, ECR repo, API routes,
operator Cognito pool, workflows, IAM) are all in the **infrastructure**
repo. This repo only holds the code and deploys it.

## How creating a customer works

```
Form submit ──POST /platform/tenants──▶ platform-tenants Lambda
   (one transaction)                     ├─ SLUG#<slug>         (slug unique)
                                         ├─ TENANT#<id>/PROFILE (status provisioning, plan limits)
                                         ├─ LOCATION rows       (the locations on the form)
                                         └─ AUDIT# row
                                        then StartExecution ─▶ tenant-onboarding (Step Functions)
                                                               ├─ Cognito: owner account with custom:tenant_id,
                                                               │  owner_user group, invite email
                                                               ├─ Stripe: connected account under YOUR platform
                                                               │  account + VAT rates on it
                                                               ├─ <slug>.<platform domain> + placeholder site
                                                               └─ status active
```

The page polls until the status is **Active** (about a minute). The only
human step left is Stripe's identity/bank form, which the owner completes
from their admin app (Settings → Payments) - or you create a link on the
customer's Payments tab and do it with them on a call.

**Who can get in:** the API Gateway route only accepts access tokens from
the *operator* Cognito pool (MFA required) with the `platform/admin` scope;
the Lambda additionally requires the `platform_admin` group. Operators are
the `platform_operator_emails` in the infrastructure tfvars.

**Forgot your password?** On the sign-in page. Cognito emails a link to
`/reset-password#code=…&email=…` (the operator pool's custom message
trigger in the infrastructure repo; the fragment never reaches a server and
the page clears it): choose a new password, then sign in with it and your
authenticator code. The link works once and for one hour. Until the pool
sends through SES (`cognito_invites_via_ses`, on in dev) the email shows a
6-digit code instead - "Got a code instead? Enter it" takes that.

## API

| Route | What |
|---|---|
| `GET /platform/plans` | plan catalog |
| `GET /platform/tenants` | all customers |
| `POST /platform/tenants` | create (the form) |
| `GET/PATCH /platform/tenants/{id}` | detail (profile, domains, locations, user count, setup run, last 25 audit entries) / edit profile |
| `PUT /platform/tenants/{id}/plan` | plan + overrides (max locations, features); `force` to go below the current location count |
| `POST .../suspend`, `.../resume` | block / unblock all of the customer's users |
| `POST .../offboard` | "delete": `{confirmSlug}`; users disabled, domains detached, data kept |
| `POST .../onboarding/retry` | re-run setup (failed → retry; active → fill in what was added since, e.g. VAT rates) |
| `GET .../users`, `POST .../owners` | list sign-in accounts / invite another owner |
| `GET/POST .../locations`, `PATCH/DELETE .../locations/{locationId}` | location CRUD; create is blocked at the plan limit (`409 plan_limit_reached`) |
| `POST .../domains`, `DELETE .../domains/{domain}` | customer's own domain (starts the attach/detach workflows) |
| `GET /platform/domains/search?q=` | availability + first-year/renewal price (Route 53 Domains, .se/.com/.eu/.net) |
| `POST .../domains/documents` | presigned POST for the registreringsbevis (PDF, required to buy a .se) |
| `POST .../domains/registrations` | buy a domain in the restaurant's AB's name: `{domain, contact, documentKey (.se), acceptedPrice}` - starts domain-provision |
| `GET /platform/domains/dns-scan?domain=` | the records a domain uses today (public DNS), for review before connecting |
| `POST .../domains/connections` | connect a domain the restaurant has: Route 53 zone with the reviewed records, then they switch name servers - starts domain-provision |
| `GET .../zones/{domain}/document` | 5-minute download link to the registreringsbevis (for the AWS Support case) |
| `GET/POST .../zones/{domain}/transfer` | move a connected, live domain's registration into Route 53: check (transferability + price) / start `{authCode, contact, documentKey (.se), acceptedPrice}` - name servers kept |

The domain-provision workflow also invokes this Lambda directly
(`{"workflowTask": ...}`, no `routeKey`) for its waiting and DNS steps -
see `api/src/app/zones.py`.
| `POST .../stripe/account-link`, `POST .../stripe/sync` | Stripe onboarding link / pull the account status now |
| `GET /platform/outbox[?after=<id>]`, `GET /platform/outbox/{messageId}` | dev mail outbox: what the platform would have emailed (and a copy of each SMS), newest first; `{"enabled": false}` when off (always in prod) |

Errors: `{"error": "<code>", "message": "...", "fields": {"field": "message"}}`.

## Local development

```bash
# API
cd api
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest            # moto-backed: DynamoDB, Cognito, Step Functions, Secrets Manager, S3

# Web - against the dev API
cd web
cp .env.example .env.local  # fill in from `tofu output` (dev)
npm install
npm run dev                 # http://localhost:5173 (an allowed sign-in callback outside prod)
```

## Deploy

`.github/workflows/deploy.yml`: PRs run the tests; a push to `dev` deploys
to dev, a push to `main` to prod. The pipeline assumes
`[dev-]platform-admin-front-end-deploy-role` via GitHub OIDC (no AWS keys),
which can only update this repo's bucket, distribution, ECR repo and Lambda.

One-time: the repo must be named **`sbs-admin`** in the org the
infrastructure trusts, and it needs two GitHub **environments** named exactly
`dev` and `prod` - the deploy role only trusts the deploy job of the
environment with its own name, so PR runs and other branches can never
deploy, and dev can never touch prod.

Each environment gets these **variables** (none are secrets). The
infrastructure repo prints all of them for its account:

```bash
tofu output -json booqy_console_deploy      # run once with the dev state, once with prod
```

| Variable | What it is |
|---|---|
| `AWS_REGION` | `eu-north-1` |
| `AWS_ROLE_ARN` | `[dev-]platform-admin-front-end-deploy-role` |
| `WEB_BUCKET` | the operator app's S3 bucket |
| `CLOUDFRONT_DISTRIBUTION_ID` | its CloudFront distribution |
| `ECR_REPOSITORY` | `[dev-]platform-tenants` |
| `LAMBDA_FUNCTION_NAME` | `[dev-]platform-tenants` |
| `VITE_API_URL` | the HTTP API |
| `VITE_COGNITO_AUTHORITY` / `VITE_COGNITO_CLIENT_ID` / `VITE_COGNITO_DOMAIN` | operator pool sign-in |
| `VITE_PLATFORM_DOMAIN` | `var.platform_domain` (empty until decided) |

What the deploy role may do - and nothing else:

| For | Permissions | On |
|---|---|---|
| web app | `s3:ListBucket`, `s3:PutObject`, `s3:DeleteObject` | the operator app bucket only |
| cache refresh | `cloudfront:CreateInvalidation` | the operator app distribution only |
| API image | ECR login + push (`BatchCheckLayerAvailability`, `BatchGetImage`, layer upload, `PutImage`) | the `platform-tenants` repo only (keeps the last 30 images) |
| API release | `lambda:UpdateFunctionCode`, `GetFunction`, `GetFunctionConfiguration` | the `platform-tenants` function only - its config, env vars, IAM and routes stay in Terraform |

Give the `prod` environment a required reviewer if prod deploys should need
an approval.

## Notes

- Deleting a customer is **offboarding**: nothing is purged (catering
  documents are under a 7-year legal lock; exports on request). Permanent
  deletion is a separate, manual decision.
- Deleting a location removes the location row and frees a plan slot; its
  menu/reservations/orders stay stored but unreachable.
- `custom:tenant_id` is immutable: an email that already has an account
  can't be added to another customer - use a different email.
