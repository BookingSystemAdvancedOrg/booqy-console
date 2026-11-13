# Booqy Console desktop app

Electron shell that opens the deployed operator console (`admin.dev.booqy.se`
or `admin.booqy.se`) in its own window. Installers: `.dmg` (macOS, arm64
and x64), `.exe` (Windows, NSIS, per-user, no admin rights), AppImage and
`.deb` (Linux x64).

## Why Electron, and why a shell around the hosted app

Electron over Tauri: Tauri renders with the OS webview (WebKitGTK on Linux,
WKWebView on macOS), where the glass `backdrop-filter`, Web Audio clicks
(see the Safari workaround) and camera scanning behave differently from
Chrome, and it needs a Rust toolchain on every build machine. Electron ships
the same Chromium on all three platforms, so the desktop app behaves exactly
like the web app we already test. The cost is size (~120 MB installer).

The window loads the real https origin instead of a bundled copy of `dist/`:

- **Sign-in is unchanged.** `LoginPage` signs in with Amplify SRP straight
  against `cognito-idp` (password change, TOTP setup and codes included), and
  the API allows CORS only from the console's own origin. A bundled `file://`
  or `app://` copy would need a new origin in the API's CORS list and the
  CSP. Same origin means no CORS change, no IAM or Terraform change.
- **No OAuth redirect exists.** The Hosted UI domain is not used for sign-in,
  so there is no callback URL, custom protocol or loopback server to secure.
  Tokens stay in `sessionStorage` as on the web: closing the window signs the
  operator out, like closing the tab.
- **CSP is CloudFront's.** The page gets the same `Content-Security-Policy`
  response header as in the browser (`script-src 'self'`, `connect-src 'self'
  ...`), and Chromium enforces it the same way. The shell never rewrites
  headers and injects no scripts (no preload). The only local page, "Ingen
  anslutning" when offline, is a `data:` URL with its own
  `default-src 'none'` policy and no script.
- **Deploys reach the app at once.** No version skew between desktop clients
  and the API. The installer only changes when the shell itself changes.

Shell hardening (`main.cjs`): `contextIsolation`, `sandbox`, no Node in the
page, no `<webview>`; navigation stays on the app origin and every other link
opens in the system browser; only clipboard write, notifications and
fullscreen (and camera, unused here) are granted, and only to the app origin;
Electron fuses turn off `RunAsNode`, `NODE_OPTIONS` and inspector flags, and
turn on asar integrity and cookie encryption. DevTools exist only in the dev
build. No secrets are in the bundle: the only baked-in value is the URL.

Theme (`booqy-theme` in localStorage), sounds and animations live in the web
app and persist in the app's own profile. Data stays per environment: the dev
build is "Booqy Console Dev" with its own app id and profile, so both can be
installed side by side.

## Build locally

```bash
cd desktop
npm ci
npm start                 # run against dev without packaging
npm run dist:dev          # installers for this OS, pointing at dev
npm run dist:prod         # same, pointing at prod
npm run dist:all:dev      # try mac + win + linux from this machine
node build.mjs --env dev --linux --only deb --arch x64   # one target
```

Output: `desktop/release/<env>/` (git-ignored). `BOOQY_URL=http://localhost:5173
npm start` points the unpackaged app at a local `npm run dev` in `web/`. Packaged apps
always use the baked-in URL.

Cross-builds: on Apple Silicon, electron-builder's `makensis` (Windows `.exe`)
and AppImage tool for macOS are x86-only and need Rosetta
(`softwareupdate --install-rosetta`). Without Rosetta a Mac builds the `.dmg`
files and the Linux `.deb` (`--linux --only deb --arch x64`). CI builds every
platform on its own runner.

## Signing (off until the owner decides, costs money)

Unsigned builds work, but users see warnings:

- **macOS:** the app is ad-hoc signed. A downloaded copy is blocked by
  Gatekeeper ("Apple could not verify..."). The user must open System
  Settings > Privacy & Security > "Open Anyway" once. Fix: Apple Developer
  Program (99 USD/year), Developer ID Application certificate, notarization.
  Cookies are encrypted with a key in the macOS keychain. An unsigned app
  gets a new signature with every build, so after installing an update macOS
  asks once whether the app may use "<name> Safe Storage" (answer "Always
  Allow"). Until then the window stays hidden. A signed app keeps one
  identity and is never asked.
- **Windows:** SmartScreen shows "Windows protected your PC" until the user
  clicks "More info" > "Run anyway". Fix: an OV/EV code signing certificate,
  or Azure Trusted Signing (about 10 USD/month).

Turn it on with environment variables only (never commit certificates):

| Platform | Variables |
| --- | --- |
| macOS sign | `BOOQY_MAC_IDENTITY="Developer ID Application: ... (TEAMID)"`, certificate in the keychain or `CSC_LINK` + `CSC_KEY_PASSWORD` |
| macOS notarize | `APPLE_API_KEY` (path to .p8), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| Windows (.pfx) | `CSC_LINK` + `CSC_KEY_PASSWORD` (or `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`) |
| Windows (Azure) | `BOOQY_AZURE_SIGN_ENDPOINT`, `BOOQY_AZURE_SIGN_ACCOUNT`, `BOOQY_AZURE_SIGN_PROFILE`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |

With an identity set, hardened runtime and the entitlements in
`build/entitlements.mac.plist` are used. Notarization runs only when the three
`APPLE_*` variables are set too.

## Where users download it

Operators are Booqy staff with GitHub access, so the console installers fit
GitHub Releases on this (private) repo: only org members can download them.
The restaurant admin app needs a public location instead (see the admin
repo's `desktop/README.md`).

CI: `desktop-installers.workflow.yml` here is a ready workflow. `.github/` is
the owner's, so copy it to `.github/workflows/desktop-installers.yml`. Run it
by hand (dev or prod), or push a tag `desktop-v<version>` (match `version` in
`package.json`) to build prod on macOS, Windows and Linux runners and attach
the installers to a GitHub Release.

Auto-update is not set up: the content updates with every web deploy, so the
shell rarely needs a new version. If wanted later, `electron-updater` works
from the same S3 location (and needs signed builds on macOS).
