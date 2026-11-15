// Ren logik för skalets uppdateringar, utan Electron, så att den går att
// testa med `node --test` (update-core.test.cjs). updates.cjs använder den.
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/** "1.10.0" > "1.9.2". Bara siffror; en prerelease-tagg ("-test") ignoreras. */
function isNewer(remote, local) {
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
  const a = parts(remote)
  const b = parts(local)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

/** SHA-256 (hex) av en fil, strömmat så att stora filer inte hamnar i minnet. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** Stämmer filen med kontrollsumman i latest.json? Fel format räknas som nej. */
async function verifySha256(file, expected) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) return false
  return (await sha256File(file)).toLowerCase() === expected.toLowerCase()
}

/** "/Applications/Booqy Admin.app" ur ".../Booqy Admin.app/Contents/MacOS/Booqy Admin". */
function bundleFromExecPath(execPath) {
  const contents = path.dirname(path.dirname(execPath))
  const bundle = path.dirname(contents)
  return path.basename(contents) === 'Contents' && bundle.endsWith('.app') ? bundle : null
}

/**
 * Kan appen byta ut sig själv där den ligger? Inte från en skivavbild, inte
 * när macOS kör den från en tillfällig kopia (App Translocation) och inte
 * utan skrivrätt till mappen. Svaret säger varför, för reservvägen.
 */
function canSwapBundle(bundle, access = fs.accessSync) {
  if (!bundle) return { ok: false, reason: 'not-a-bundle' }
  if (bundle.includes('/AppTranslocation/')) return { ok: false, reason: 'translocated' }
  if (bundle.startsWith('/Volumes/') && !/^\/Volumes\/[^/]+\/(Applications|Users)\//.test(bundle)) {
    return { ok: false, reason: 'disk-image' }
  }
  try {
    access(path.dirname(bundle), fs.constants.W_OK)
    access(bundle, fs.constants.W_OK)
  } catch {
    return { ok: false, reason: 'no-write-permission' }
  }
  return { ok: true }
}

/**
 * Den nya appens zip för den här Macen ur latest.json, eller null. Bara https;
 * http://127.0.0.1 bara i det lokala testet (allowLocal).
 */
function macZipFor(latest, arch, allowLocal = false) {
  const entry = latest && latest.macZip && latest.macZip[arch === 'arm64' ? 'arm64' : 'x64']
  const okUrl = (u) => /^https:\/\//.test(u) || (allowLocal && /^http:\/\/127\.0\.0\.1[:/]/.test(u))
  if (!entry || typeof entry.url !== 'string' || !okUrl(entry.url)) return null
  if (typeof entry.sha256 !== 'string') return null
  return { url: entry.url, sha256: entry.sha256, size: Number(entry.size) || 0 }
}

/**
 * Skalskript som byter appen när den har stängts: väntar på processen, flyttar
 * den gamla åt sidan, lägger den nya på samma plats, återställer den gamla om
 * något går fel och startar (om så önskas) den nya. Argument: pid, nuvarande
 * app, nya appen, 1/0 för omstart.
 */
const SWAP_SCRIPT = `#!/bin/sh
pid="$1"; cur="$2"; new="$3"; relaunch="$4"
i=0
# Avbröts avslutet (t.ex. osparade ändringar): vänta vidare, byt när appen
# till slut stängs, men starta då inte om den av sig själv.
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 600 ]; then relaunch=0; sleep 2; else sleep 0.1; fi
done
bak="$cur.old-$$"
if mv "$cur" "$bak"; then
  if mv "$new" "$cur"; then rm -rf "$bak"; else mv "$bak" "$cur"; fi
fi
rm -rf "$(dirname "$new")"
xattr -dr com.apple.quarantine "$cur" 2>/dev/null
[ "$relaunch" = "1" ] && open "$cur"
exit 0
`

/** Mappen bredvid appen där den nya packas upp (samma volym, så bytet blir ett namnbyte). */
function stagingDirFor(bundle) {
  return path.join(path.dirname(bundle), `.${path.basename(bundle)}.update`)
}

module.exports = { isNewer, sha256File, verifySha256, bundleFromExecPath, canSwapBundle, macZipFor, SWAP_SCRIPT, stagingDirFor }
