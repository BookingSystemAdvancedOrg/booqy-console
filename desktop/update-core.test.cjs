// node --test (npm test i desktop/). Testar versionsjämförelsen, kontrollsumman,
// kontrollerna före bytet och själva bytesskriptet mot riktiga mappar.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const core = require('./update-core.cjs')

test('isNewer compares major, minor and patch', () => {
  assert.equal(core.isNewer('1.3.4', '1.3.3'), true)
  assert.equal(core.isNewer('1.10.0', '1.9.9'), true)
  assert.equal(core.isNewer('2.0.0', '1.99.99'), true)
  assert.equal(core.isNewer('1.3.3', '1.3.3'), false)
  assert.equal(core.isNewer('1.3.2', '1.3.3'), false)
  assert.equal(core.isNewer('1.3.5-test', '1.3.4'), true)
  assert.equal(core.isNewer('garbage', '1.0.0'), false)
})

test('verifySha256 accepts the right sum and rejects a wrong or malformed one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booqy-sha-'))
  const file = path.join(dir, 'app.zip')
  fs.writeFileSync(file, 'booqy update payload')
  const good = crypto.createHash('sha256').update('booqy update payload').digest('hex')
  assert.equal(await core.verifySha256(file, good), true)
  assert.equal(await core.verifySha256(file, good.toUpperCase()), true)
  assert.equal(await core.verifySha256(file, good.replace(/.$/, good.endsWith('0') ? '1' : '0')), false)
  assert.equal(await core.verifySha256(file, 'not-a-sha'), false)
  assert.equal(await core.verifySha256(file, undefined), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('bundleFromExecPath finds the .app', () => {
  assert.equal(core.bundleFromExecPath('/Applications/Booqy Admin.app/Contents/MacOS/Booqy Admin'), '/Applications/Booqy Admin.app')
  assert.equal(core.bundleFromExecPath('/usr/local/bin/electron'), null)
})

test('canSwapBundle refuses translocated apps, disk images and read-only folders', () => {
  const allow = () => {}
  const deny = () => { throw new Error('EACCES') }
  assert.deepEqual(core.canSwapBundle('/Applications/Booqy Admin.app', allow), { ok: true })
  assert.equal(core.canSwapBundle('/private/var/folders/x/AppTranslocation/ABC/d/Booqy Admin.app', allow).reason, 'translocated')
  assert.equal(core.canSwapBundle('/Volumes/Booqy Admin/Booqy Admin.app', allow).reason, 'disk-image')
  assert.equal(core.canSwapBundle('/Applications/Booqy Admin.app', deny).reason, 'no-write-permission')
  assert.equal(core.canSwapBundle(null, allow).reason, 'not-a-bundle')
})

test('macZipFor picks the right architecture and only https', () => {
  const latest = {
    macZip: {
      arm64: { url: 'https://dev.booqy.se/downloads/x-arm64.zip', sha256: 'a'.repeat(64), size: 10 },
      x64: { url: 'http://insecure/x64.zip', sha256: 'b'.repeat(64) },
    },
  }
  assert.equal(core.macZipFor(latest, 'arm64').url, 'https://dev.booqy.se/downloads/x-arm64.zip')
  assert.equal(core.macZipFor(latest, 'x64'), null)
  assert.equal(core.macZipFor({}, 'arm64'), null)
  const local = { macZip: { arm64: { url: 'http://127.0.0.1:8790/a.zip', sha256: 'c'.repeat(64) } } }
  assert.equal(core.macZipFor(local, 'arm64'), null)
  assert.equal(core.macZipFor(local, 'arm64', true).url, 'http://127.0.0.1:8790/a.zip')
})

function fakeBundle(dir, name, version) {
  const app = path.join(dir, name)
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'version'), version)
  return app
}

function runSwap(cur, staged, waitFor) {
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'booqy-swap-')), 'swap.sh')
  fs.writeFileSync(script, core.SWAP_SCRIPT, { mode: 0o755 })
  execFileSync('/bin/sh', [script, String(waitFor), cur, staged, '0'])
}

test('swap script replaces the app in place after the process has quit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booqy-apps-'))
  const cur = fakeBundle(dir, 'Booqy Admin.app', '1.3.4')
  const staging = core.stagingDirFor(cur)
  const staged = fakeBundle(staging, 'Booqy Admin.app', '1.3.5')
  // Not our child (like the real app): a child would linger as a zombie while
  // execFileSync blocks, and the script would wait for it.
  const pid = Number(execFileSync('/bin/sh', ['-c', 'sleep 0.5 >/dev/null 2>&1 & echo $!']).toString().trim())
  runSwap(cur, staged, pid)
  assert.equal(fs.readFileSync(path.join(cur, 'Contents', 'version'), 'utf8'), '1.3.5')
  assert.equal(fs.existsSync(staging), false)
  assert.deepEqual(fs.readdirSync(dir), ['Booqy Admin.app'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('swap script keeps the old app when the new one is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booqy-apps-'))
  const cur = fakeBundle(dir, 'Booqy Admin.app', '1.3.4')
  runSwap(cur, path.join(core.stagingDirFor(cur), 'Booqy Admin.app'), 999999)
  assert.equal(fs.readFileSync(path.join(cur, 'Contents', 'version'), 'utf8'), '1.3.4')
  fs.rmSync(dir, { recursive: true, force: true })
})
