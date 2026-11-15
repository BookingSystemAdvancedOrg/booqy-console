# Console end-to-end tests (live dev)

Playwright specs that drive the real dev Booqy Console (`admin.dev.booqy.se`)
as a dedicated test operator. `10-new-customer.e2e.ts` creates the `E2E`
test restaurant that the admin suite (`admin-front-end/e2e`) uses.

Never point them at prod (the config refuses `admin.booqy.se`).

## Run

```bash
npm ci
npx playwright install chromium webkit
npm test                       # setup + chromium + iphone (WebKit) + tablet
node summarize.mjs             # one line per test
```

## Settings (env vars, or a local file outside git)

Read from the environment or from `E2E_ENV_FILE` (default
`../../.e2e-credentials.env`). Never commit that file.

| Name | What |
| --- | --- |
| `E2E_CONSOLE_URL` | default `https://admin.dev.booqy.se` |
| `E2E_OPERATOR_EMAIL`, `E2E_OPERATOR_PASSWORD` | the test operator (operator pool, `platform_admin`) |
| `E2E_OPERATOR_TOTP_SECRET` | written on the first sign-in, when the suite sets up the authenticator |
| `E2E_TENANT_ID` | written when the E2E restaurant is created |

The operator session is saved in `.auth/` (gitignored) and reused for 12
hours, because Cognito refuses a TOTP code used twice.
