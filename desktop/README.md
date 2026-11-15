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

Prices checked 2026-11-14 (nothing bought): Apple Developer Program USD 99 a
year (Developer ID plus notarization; also allows Squirrel.Mac updates and
turns cookie encryption back on without keychain prompts). Azure Artifact
Signing (formerly Trusted Signing) Basic USD 9.99 a month (5,000 signatures,
then USD 0.005 each), for organisations in the US, Canada and Europe.

## Where users download it

`https://dev.booqy.se/downloads/console/latest/` (dev) and
`https://booqy.se/downloads/console/latest/` (prod), stable names:
`Booqy-Console-mac-arm64.dmg`, `Booqy-Console-mac-x64.dmg`, `Booqy-Console-Setup.exe`,
`Booqy-Console.AppImage`, `Booqy-Console.deb`. Each build also keeps an immutable copy
under `/downloads/versions/console/<version>-<sha7>/`, and `latest.json` lists
them. The download card in settings (and booqy.se/ladda-ner for the admin)
picks the file for the visitor's computer.

## Updates (silent, no installer windows)

- **The web app** (what the window shows) updates with every web deploy. The
  page compares `index.html`'s ETag every 60 s and on focus and shows
  "Ny version finns" with a Ladda om button. It never reloads by itself.
- **The shell** (this folder) checks 15 s after start, every 6 hours and from
  Hjälp > Sök efter uppdateringar. It downloads a newer version in the
  background and shows a glass toast "Uppdatering klar (x.y.z) / Starta om".
  Without a click it installs when the app quits. No installer, no DMG, no
  Finder or SmartScreen dialog (`updates.cjs`, logic in `update-core.cjs`):
  - **Windows:** electron-updater with the NSIS installer run silently
    (per-user, no UAC), differential download via `.blockmap`. Feed:
    `<downloads>/<app>/updates/latest.yml`. A file the app downloads itself
    has no Mark-of-the-Web, so SmartScreen does not step in.
  - **macOS** (unsigned, so Squirrel.Mac cannot be used): the app downloads
    the `.zip` of the new `.app`, checks its SHA-256 against `latest.json`
    (`macZip`), unpacks it next to itself, checks bundle id and version, and
    after quitting a small script swaps the bundle in place and relaunches.
    It falls back to a toast with a download link when it cannot swap: no
    write permission to the folder, running from the disk image, or macOS App
    Translocation (run once from Applications to fix).
    Cookie encryption is off for unsigned macOS builds: an unsigned app gets
    a new signature with every version, and macOS would ask about the
    keychain after every update. It turns on by itself once the app is signed.
  - **Linux:** the AppImage updates itself like Windows
    (`latest-linux.yml`). A `.deb` cannot be replaced without sudo, so it
    gets a toast linking to the new file.
- **The very first install** still shows the OS warning (Gatekeeper,
  SmartScreen): that is only fixable with signing (below).
- **Moving from 1.3.x:** 1.3.x only knows the old flow (download and open the
  installer), so the step to 1.4.0 shows the installer once. From 1.4.0 on,
  updates are silent.

### When to release a new shell version

Rarely. The window loads the live web app, so web changes never need an
installer. Bump `version` in `package.json` only for real shell changes
(main.cjs, updates, window, icons, Electron upgrades). Every bump builds three
platforms in CI (macOS minutes are expensive) and every running app installs it.

### Test the update locally (macOS)

```bash
BOOQY_TEST_SUFFIX=Updatetest node build.mjs --env dev --mac --only zip --arch arm64
# copy release/dev/mac-arm64/*.app to a writable folder ("old"), then:
BOOQY_TEST_SUFFIX=Updatetest BOOQY_TEST_VERSION=1.4.1 node build.mjs --env dev --mac --only zip --arch arm64
# serve a folder with the new zip and a latest.json {version, macZip: {arm64: {url, sha256}}}
BOOQY_UPDATE_TEST=1 BOOQY_UPDATE_FEED=http://127.0.0.1:8790/feed "<old>.app/Contents/MacOS/<name>"
```

The suffix gives the test app its own name and profile. The feed override and
`http://127.0.0.1` are only honoured with `BOOQY_UPDATE_TEST=1`.
`npm test` runs the version check, checksum and swap tests.

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
