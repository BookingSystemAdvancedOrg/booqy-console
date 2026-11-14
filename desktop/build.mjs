// Bygger installationsfilerna. Användning (se README.md):
//   node build.mjs --env dev|prod [--mac] [--win] [--linux]
// Utan plattformsflagga byggs den plattform du sitter på.
//
// Signering är AV tills ägaren lägger in certifikat. Allt styrs med
// miljövariabler, aldrig med filer i repot:
//   macOS   BOOQY_MAC_IDENTITY="Developer ID Application: ... (TEAMID)"
//           (certifikatet i nyckelringen, eller CSC_LINK + CSC_KEY_PASSWORD)
//           notarisering: APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER
//   Windows CSC_LINK + CSC_KEY_PASSWORD (.pfx), eller Azure Trusted Signing:
//           BOOQY_AZURE_SIGN_ENDPOINT, BOOQY_AZURE_SIGN_ACCOUNT,
//           BOOQY_AZURE_SIGN_PROFILE (+ AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET)
import { build } from 'electron-builder'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    env: { type: 'string', default: 'dev' },
    mac: { type: 'boolean', default: false },
    win: { type: 'boolean', default: false },
    linux: { type: 'boolean', default: false },
    // Bara vissa mål, t.ex. --only deb (AppImage och nsis kräver Rosetta på Apple Silicon).
    // --only tar processorn från den här flaggan (annars datorns egen), t.ex. --arch x64.
    only: { type: 'string' },
    arch: { type: 'string' },
  },
})

const config = JSON.parse(readFileSync(new URL('./desktop.config.json', import.meta.url), 'utf8'))
const env = values.env
const url = config.urls[env]
if (!url) {
  console.error(`Okänd miljö "${env}". Välj en av: ${Object.keys(config.urls).join(', ')}`)
  process.exit(1)
}
const isProd = env === 'prod'
// Bara för det lokala testet av uppdateringen (README): ett eget appnamn och
// en egen version, så att testappen inte delar profil med en installerad app.
const testSuffix = process.env.BOOQY_TEST_SUFFIX ?? ''
const productName = (isProd ? config.productName : `${config.productName} Dev`) + (testSuffix ? ` ${testSuffix}` : '')
const appId = (isProd ? config.appId : `${config.appId}.dev`) + (testSuffix ? `.${testSuffix.toLowerCase()}` : '')
const fileBase = (isProd ? config.fileName : `${config.fileName}-dev`) + (testSuffix ? `-${testSuffix.toLowerCase()}` : '')

// Adressen bakas in i appen; main.cjs läser den här filen.
writeFileSync(new URL('./env.json', import.meta.url), JSON.stringify({ env, url }, null, 2) + '\n')

const env_ = process.env
const macIdentity = env_.BOOQY_MAC_IDENTITY || null
const canNotarize = Boolean(macIdentity && env_.APPLE_API_KEY && env_.APPLE_API_KEY_ID && env_.APPLE_API_ISSUER)
const azureSign = env_.BOOQY_AZURE_SIGN_ENDPOINT
  ? {
      endpoint: env_.BOOQY_AZURE_SIGN_ENDPOINT,
      codeSigningAccountName: env_.BOOQY_AZURE_SIGN_ACCOUNT,
      certificateProfileName: env_.BOOQY_AZURE_SIGN_PROFILE,
      publisherName: 'Booqy',
    }
  : undefined

// Tom lista = målen i konfigurationen nedan (dmg, nsis, AppImage + deb).
const platforms = {}
if (values.mac) platforms.mac = []
if (values.win) platforms.win = []
if (values.linux) platforms.linux = []
if (values.only) for (const k of Object.keys(platforms)) platforms[k] = values.only.split(',')
if (values.arch) platforms[values.arch] = true

/** @type {import('electron-builder').Configuration} */
const builderConfig = {
  appId,
  productName,
  copyright: 'Booqy',
  artifactName: `${fileBase}-\${version}-\${os}-\${arch}.\${ext}`,
  directories: { output: `release/${env}`, buildResources: 'build' },
  files: ['main.cjs', 'updates.cjs', 'update-core.cjs', 'desktop.config.json', 'env.json', 'package.json'],
  extraMetadata: { name: fileBase, productName, ...(process.env.BOOQY_TEST_VERSION ? { version: process.env.BOOQY_TEST_VERSION } : {}) },
  asar: true,
  // Härdning av själva Electron-binären.
  electronFuses: {
    runAsNode: false,
    // Kakorna krypteras med en nyckel i macOS nyckelring. En osignerad app får
    // en ny signatur vid varje version, och då frågar macOS om nyckeln efter
    // varje uppdatering. Därför av för osignerad macOS, på när appen signeras.
    enableCookieEncryption: macIdentity ? true : process.platform !== 'darwin',
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  mac: {
    category: 'public.app-category.business',
    // dmg för första installationen, zip för appens egna tysta uppdateringar.
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    icon: 'build/icon.png',
    // Utan certifikat: ad hoc-signerad ("-"), kör lokalt men Gatekeeper
    // varnar på andra datorer. Se README.md, "Signering".
    identity: macIdentity ?? '-',
    // Hardened runtime krävs för notarisering; ad hoc-signerat utan den.
    hardenedRuntime: Boolean(macIdentity),
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: canNotarize,
    extendInfo: {
      NSCameraUsageDescription: 'Kameran används för att skanna biljetter och QR-koder.',
    },
  },
  dmg: { title: productName, writeUpdateInfo: false },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    ...(azureSign ? { azureSignOptions: azureSign } : {}),
  },
  nsis: {
    // Installeras för den inloggade användaren: inga administratörsrättigheter.
    oneClick: true,
    perMachine: false,
    installerLanguages: ['sv_SE'],
    language: '1053',
    shortcutName: productName,
  },
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    // Linux vill ha en hel uppsättning (hicolor 16 till 1024), annars visar
    // vissa skrivbord ingen ikon. Skapad ur build/icon.png, se README.md.
    icon: 'build/icons',
    category: 'Office',
    maintainer: 'Booqy <ops@booqy.se>',
    synopsis: config.description,
    executableName: fileBase,
  },
  // Uppdateringskanalen (latest.yml, latest-linux.yml) för electron-updater på
  // Windows och AppImage. Inget laddas upp härifrån: publish.mjs gör det i CI.
  publish: [{ provider: 'generic', url: `${config.downloads[env]}/updates` }],
}

await build({ ...platforms, config: builderConfig, publish: 'never' })
console.log(`\nKlart: ${productName} (${env}, ${url}) i release/${env}/`)
