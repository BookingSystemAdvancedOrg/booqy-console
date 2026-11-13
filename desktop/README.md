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

## See-through glass window

The window is translucent and the desktop behind it shows through, blurred:

| Platform | How | Notes |
| --- | --- | --- |
| macOS | `vibrancy: 'under-window'`, `visualEffectState: 'active'`, clear background | Native blur of everything behind the window, also when it is not focused. |
| Windows 11 22H2+ | `backgroundMaterial: 'acrylic'`, clear background | Acrylic blurs the desktop. Windows 10 and older 11 builds get the normal solid window. |
| Linux | `transparent: true`, clear background | No reliable native blur: the page lays a dense tint behind all text instead. |

The shell adds `BooqyGlass/<vibrancy|acrylic|tint|none>` to the user agent;
the web app reads it and puts `is-desktop-glass` (and `data-desktop-glass`) on
`<html>`, makes every layer from `html` and `body` down to the app shell
transparent (no brand photo, colour pools or veil in the desktop app: the
panels themselves are the glass) and gives each panel a low tint, dense
enough for WCAG AA. Other windows behind the app show through live, blurred.
macOS fixes the blur strength of its materials: colours and large shapes
behind read clearly, small text behind does not. In a browser nothing changes. macOS "Reduce
transparency", `prefers-reduced-transparency`, or `BOOQY_GLASS=off npm start`
give the solid window. The native material follows the app's own light/dark
theme (the shell reads `data-theme` on `<html>`, it never writes to the page).

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

`https://dev.booqy.se/downloads/console/latest/` (dev) and
`https://booqy.se/downloads/console/latest/` (prod), stable names:
`Booqy-Console-mac-arm64.dmg`, `Booqy-Console-mac-x64.dmg`, `Booqy-Console-Setup.exe`,
`Booqy-Console.AppImage`, `Booqy-Console.deb`. Each build also keeps an immutable copy
under `/downloads/versions/console/<version>-<sha7>/`, and `latest.json` lists
them. The download card in settings (and booqy.se/ladda-ner for the admin)
picks the file for the visitor's computer.

## Updates

- **The web app** (what the window shows) updates with every web deploy. The
  page compares `index.html`'s ETag every 60 s and on focus and shows
  "Ny version finns" with a Ladda om button. It never reloads by itself.
- **The shell** (this folder) checks `latest.json` 15 s after start and every
  6 hours, and from Hjälp > Sök efter uppdateringar. When `version` in
  `package.json` is higher than the installed one it offers Uppdatera, which
  downloads the installer to Hämtade filer and opens it. Bump `version` when
  you change the shell, or nobody is offered the new build.

## CI

`.github/workflows/desktop-installers.yml` builds on macOS, Windows and Linux
runners whenever `desktop/` changes on `dev` (publishes to dev) or `main`
(prod), or by hand. `publish.mjs` uploads through `desktop-release-role`
(Terraform: `network/platform-domain/downloads.tf` and
`security/iam/oidc/desktop-release-role` in infrastructure).

## App icon

off-white square, black b (`icon.png` is a copy of `icon-light.png`). Only two square logos are allowed: black square with an off-white b, or
off-white square with a black b (never a wine-red square). Booqy Admin uses the
black one, Booqy Console the off-white one, so they differ in the Dock and
taskbar. electron-builder makes the `.icns` (macOS) and `.ico` (Windows) from
`build/icon.png`; Linux uses the PNG set in `build/icons/`. After changing
`icon.png`, regenerate that set:

```bash
for s in 16 24 32 48 64 128 256 512 1024; do sips -z $s $s build/icon.png --out build/icons/${s}x${s}.png; done
```
