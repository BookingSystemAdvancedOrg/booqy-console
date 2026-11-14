// Uppdateringar av själva skalet, tysta: inga installationsfönster, inga
// skivavbilder, inga Finder-frågor. Webbappen i fönstret uppdateras med varje
// deploy av sig själv ("Ny version finns"); skalet ändras bara när desktop/
// ändras, och då lägger CI en ny version bredvid installationsfilerna
// (desktop/publish.mjs). Appen hämtar den i bakgrunden och visar en glasruta
// "Uppdatering klar" med Starta om. Annars installeras den när appen avslutas.
//
//   Windows   electron-updater + NSIS (per användare, utan UAC). En fil som
//             appen själv laddar ner får ingen Mark-of-the-Web, så SmartScreen
//             frågar inte.
//   macOS     Osignerad app, så Squirrel.Mac går inte. I stället: zip med den
//             nya .app, SHA-256 mot latest.json, packas upp bredvid appen och
//             byts på plats när appen stängs (update-core.cjs SWAP_SCRIPT).
//   Linux     AppImage via electron-updater. .deb kan inte bytas utan sudo:
//             rutan länkar till den nya filen.
//
// Rutan läggs in i sidan med executeJavaScript (ingen preload). Knappen går
// till booqy-shell://<åtgärd>, som main.cjs fångar i will-navigate.
'use strict'

const { app, dialog, net, shell } = require('electron')
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const core = require('./update-core.cjs')

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 15 * 1000

const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))))

function log(...args) {
  console.warn('[uppdatering]', ...args)
}

/** Glasrutan i fönstret. Samma utseende som webbappens "Ny version finns". */
function toastScript({ text, button, action }) {
  const data = JSON.stringify({ text, button, action })
  return `(() => {
  const d = ${data};
  const id = 'booqy-shell-update';
  document.getElementById(id)?.remove();
  if (!document.getElementById(id + '-style')) {
    const s = document.createElement('style'); s.id = id + '-style';
    s.textContent = '#' + id + '{position:fixed;z-index:2147483001;left:50%;bottom:max(16px,env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 10px 10px 18px;border-radius:16px;border:1px solid var(--glass-edge,rgba(253,250,246,.55));background:var(--glass-pop,rgba(251,250,246,.8));color:var(--ink,#1c1918);-webkit-backdrop-filter:blur(20px) saturate(1.5);backdrop-filter:blur(20px) saturate(1.5);box-shadow:0 14px 34px -12px rgba(28,25,24,.45);font:600 .95rem/1.3 system-ui,-apple-system,"Segoe UI",sans-serif}'
      + '#' + id + ' button{appearance:none;border:0;border-radius:999px;padding:9px 16px;background:#1c1918;color:#fbfaf6;font:inherit;font-weight:700;white-space:nowrap;cursor:pointer}'
      + '#' + id + ' .x{background:transparent;color:inherit;opacity:.7;padding:0;width:32px;height:32px}'
      + '[data-theme="dark"] #' + id + '{background:var(--glass-pop,rgba(31,22,18,.82));color:#f6ece9}'
      + '[data-theme="dark"] #' + id + ' button:not(.x){background:#fbfaf6;color:#1c1918}';
    document.head.appendChild(s);
  }
  const box = document.createElement('div'); box.id = id; box.setAttribute('role', 'status');
  const t = document.createElement('span'); t.textContent = d.text;
  const b = document.createElement('button'); b.type = 'button'; b.textContent = d.button;
  b.addEventListener('click', () => { b.disabled = true; location.href = 'booqy-shell://' + d.action; });
  const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '\\u00d7';
  x.setAttribute('aria-label', 'Senare'); x.title = 'Senare: installeras när du avslutar appen';
  x.addEventListener('click', () => box.remove());
  box.append(t, b, x); document.body.appendChild(box);
})()`
}

function setUpUpdates({ baseUrl, getWindow }) {
  // Bara för det lokala testet av hela flödet (README, "Testa uppdateringen").
  const testFeed = process.env.BOOQY_UPDATE_TEST === '1' ? process.env.BOOQY_UPDATE_FEED : null
  const feed = testFeed || baseUrl
  if (!feed) return { checkNow: async () => {}, handleAction: () => false }

  let toast = null // { text, button, action } medan en uppdatering väntar
  let busy = false
  let ready = null // macOS: { staged, version }
  let swapStarted = false

  function showToast(next) {
    toast = next
    const win = getWindow()
    if (win && !win.isDestroyed()) void win.webContents.executeJavaScript(toastScript(next), true).catch(() => {})
  }

  // Rutan ligger kvar efter en omladdning av sidan.
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('did-finish-load', () => toast && showToast(toast))
  })
  const first = getWindow()
  first?.webContents.on('did-finish-load', () => toast && showToast(toast))

  async function info(message, detail) {
    const win = getWindow()
    if (win) await dialog.showMessageBox(win, { type: 'info', message, detail, buttons: ['OK'] })
  }

  async function fetchLatest() {
    const res = await net.fetch(`${feed}/latest.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`latest.json svarade ${res.status}`)
    return res.json()
  }

  // ---- Windows och AppImage: electron-updater --------------------------------
  let autoUpdater = null
  const useElectronUpdater = process.platform === 'win32' || (process.platform === 'linux' && process.env.APPIMAGE)
  if (useElectronUpdater) {
    autoUpdater = require('electron-updater').autoUpdater
    autoUpdater.logger = null
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowDowngrade = false
    if (testFeed) autoUpdater.setFeedURL({ provider: 'generic', url: `${testFeed}/updates` })
    autoUpdater.on('update-downloaded', (u) => {
      showToast({ text: `Uppdatering klar (${u.version})`, button: 'Starta om', action: 'restart' })
    })
    autoUpdater.on('error', (err) => log(err?.message ?? err))
  }

  // ---- macOS: zip, kontrollsumma, byte på plats --------------------------------
  async function downloadTo(url, file) {
    const res = await net.fetch(url, { cache: 'no-store' })
    if (!res.ok || !res.body) throw new Error(`nedladdningen svarade ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file))
  }

  async function prepareMac(latest) {
    const bundle = core.bundleFromExecPath(process.execPath)
    const can = core.canSwapBundle(bundle)
    const zip = core.macZipFor(latest, process.arch, Boolean(testFeed))
    if (!can.ok || !zip) return { fallback: can.ok ? 'no-zip' : can.reason }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booqy-update-'))
    const file = path.join(tmp, 'app.zip')
    try {
      await downloadTo(zip.url, file)
      if (!(await core.verifySha256(file, zip.sha256))) throw new Error('kontrollsumman stämmer inte')
      const staging = core.stagingDirFor(bundle)
      fs.rmSync(staging, { recursive: true, force: true })
      fs.mkdirSync(staging, { recursive: true })
      await run('/usr/bin/ditto', ['-x', '-k', file, staging])
      const staged = path.join(staging, path.basename(bundle))
      // Samma app (id) och den version latest.json lovade, annars inget byte.
      const plist = path.join(staged, 'Contents', 'Info.plist')
      const id = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])
      const myId = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')])
      const version = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])
      if (id !== myId || version !== latest.version) {
        fs.rmSync(staging, { recursive: true, force: true })
        throw new Error(`fel app i zip (${id} ${version})`)
      }
      // Appens egen nedladdning får ingen karantän, men säkert är säkert.
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {})
      ready = { staged, bundle, version }
      return { ready: true }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  function startSwap(relaunch) {
    if (!ready || swapStarted) return false
    swapStarted = true
    const script = path.join(os.tmpdir(), `booqy-swap-${process.pid}.sh`)
    fs.writeFileSync(script, core.SWAP_SCRIPT, { mode: 0o755 })
    spawn('/bin/sh', [script, String(process.pid), ready.bundle, ready.staged, relaunch ? '1' : '0'], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return true
  }

  // Inte omstartad via rutan: byt när appen avslutas, utan att starta om.
  app.on('will-quit', () => {
    if (process.platform === 'darwin') startSwap(false)
  })

  // ---- Gemensamt ----------------------------------------------------------------
  function fallbackToast(latest) {
    const key = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : 'linux-deb'
    const url = latest?.latest?.[key] || latest?.files?.[key]
    if (!url) return
    fallbackUrl = url
    showToast({ text: `Ny version av appen: ${latest.version}`, button: 'Ladda ner', action: 'download' })
  }
  let fallbackUrl = null

  async function check({ manual = false } = {}) {
    if (busy) {
      if (manual) await info('Uppdateringen hämtas redan', 'Den installeras när den är klar.')
      return
    }
    if (toast) {
      if (manual) await info('En uppdatering är klar', 'Tryck Starta om i rutan längst ned, eller avsluta appen.')
      return
    }
    busy = true
    try {
      if (autoUpdater) {
        const result = await autoUpdater.checkForUpdates()
        const found = result?.updateInfo?.version && core.isNewer(result.updateInfo.version, app.getVersion())
        if (manual && !found) await info('Du har den senaste versionen', `${app.getName()} ${app.getVersion()}`)
        if (manual && found) await info('Ny version hittad', 'Den hämtas i bakgrunden och installeras utan frågor.')
        return
      }
      const latest = await fetchLatest()
      if (!latest?.version || !core.isNewer(latest.version, app.getVersion())) {
        if (manual) await info('Du har den senaste versionen', `${app.getName()} ${app.getVersion()}`)
        return
      }
      if (process.platform === 'darwin') {
        const r = await prepareMac(latest)
        if (r.ready) {
          showToast({ text: `Uppdatering klar (${latest.version})`, button: 'Starta om', action: 'restart' })
          return
        }
        log('byte på plats går inte:', r.fallback)
        // Ingen skrivrätt, skivavbild eller tillfällig kopia: länka till filen,
        // med en förklaring i rutan i stället för en systemdialog.
        fallbackToast(latest)
        return
      }
      fallbackToast(latest) // .deb
    } catch (err) {
      log(err?.message ?? err)
      if (manual) await info('Kunde inte söka efter uppdateringar', 'Kontrollera internetanslutningen och försök igen.')
    } finally {
      busy = false
    }
  }

  /** Från rutans knapp (booqy-shell://<åtgärd>, se main.cjs). */
  function handleAction(action) {
    if (action === 'restart') {
      toast = null
      if (autoUpdater) {
        // Tyst installation (NSIS /S) och omstart.
        setImmediate(() => autoUpdater.quitAndInstall(true, true))
        return true
      }
      if (startSwap(true)) {
        app.quit()
        return true
      }
      return false
    }
    if (action === 'download' && fallbackUrl) {
      void shell.openExternal(fallbackUrl)
      return true
    }
    return false
  }

  setTimeout(() => void check(), FIRST_CHECK_MS)
  setInterval(() => void check(), CHECK_EVERY_MS)
  return { checkNow: () => check({ manual: true }), handleAction }
}

module.exports = { setUpUpdates }
