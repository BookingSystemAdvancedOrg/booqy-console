// Laddar upp installationsfilerna till https://<domän>/downloads/ (anropas av
// .github/workflows/desktop-installers.yml efter att alla tre OS byggt).
//   node publish.mjs --env dev --dir <mapp med filerna> --bucket <bucket>
// Kräver AWS CLI och en roll med s3:PutObject (desktop-release-role).
//
// Layout i bucketen (och på webben under /downloads/):
//   versions/<app>/<version>-<sha7>/<originalnamn>   oföränderligt, cachas ett år
//   <app>/latest/<Fast-Namn>                          stabila länkar, 5 min cache
//   <app>/latest.json                                  läses av skalet (updates.cjs)
// latest.json pekar på de oföränderliga filerna och laddas upp sist, så en
// klient ser aldrig en version vars filer inte finns ännu.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    env: { type: 'string' },
    dir: { type: 'string' },
    bucket: { type: 'string' },
    sha: { type: 'string', default: process.env.GITHUB_SHA ?? 'local' },
  },
})
if (!values.env || !values.dir || !values.bucket) {
  console.error('Användning: node publish.mjs --env dev|prod --dir <mapp> --bucket <bucket>')
  process.exit(1)
}

const config = JSON.parse(readFileSync(new URL('./desktop.config.json', import.meta.url), 'utf8'))
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const baseUrl = config.downloads[values.env] // https://dev.booqy.se/downloads/admin
const slug = baseUrl.split('/').pop()
const root = baseUrl.slice(0, -slug.length - 1) // https://dev.booqy.se/downloads
const stable = config.productName.replace(/\s+/g, '-') // Booqy-Admin

// Fast namn per plattform, i samma ordning som nyckeln i latest.json.
const kinds = [
  { key: 'mac-arm64', match: /mac-arm64\.dmg$/, name: `${stable}-mac-arm64.dmg` },
  { key: 'mac-x64', match: /mac-x64\.dmg$/, name: `${stable}-mac-x64.dmg` },
  { key: 'win-x64', match: /\.exe$/, name: `${stable}-Setup.exe` },
  { key: 'linux-appimage', match: /\.AppImage$/, name: `${stable}.AppImage` },
  { key: 'linux-deb', match: /\.deb$/, name: `${stable}.deb` },
]

const found = readdirSync(values.dir)
const versionDir = `${version}-${values.sha.slice(0, 7)}`
const files = {}
const latest = {}

function put(local, key, cacheControl, downloadName) {
  const args = ['s3', 'cp', local, `s3://${values.bucket}/downloads/${key}`, '--cache-control', cacheControl, '--only-show-errors']
  if (downloadName) args.push('--content-disposition', `attachment; filename="${downloadName}"`)
  execFileSync('aws', args, { stdio: 'inherit' })
}

for (const kind of kinds) {
  const file = found.find((f) => kind.match.test(f))
  if (!file) {
    console.warn(`Saknas: ${kind.key}`)
    continue
  }
  const local = join(values.dir, file)
  put(local, `versions/${slug}/${versionDir}/${file}`, 'public, max-age=31536000, immutable', kind.name)
  put(local, `${slug}/latest/${kind.name}`, 'public, max-age=300', kind.name)
  files[kind.key] = `${root}/versions/${slug}/${versionDir}/${encodeURIComponent(file)}`
  latest[kind.key] = `${baseUrl}/latest/${kind.name}`
  console.log(`${kind.key}: ${latest[kind.key]}`)
}

if (Object.keys(files).length === 0) {
  console.error('Inga installationsfiler hittades i', values.dir)
  process.exit(1)
}

const manifest = { app: slug, env: values.env, version, sha: values.sha, date: new Date().toISOString(), files, latest }
const manifestPath = join(values.dir, 'latest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
execFileSync(
  'aws',
  ['s3', 'cp', manifestPath, `s3://${values.bucket}/downloads/${slug}/latest.json`, '--cache-control', 'public, max-age=60', '--content-type', 'application/json', '--only-show-errors'],
  { stdio: 'inherit' },
)
console.log(`latest.json: ${baseUrl}/latest.json (${version})`)
