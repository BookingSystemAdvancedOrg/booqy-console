// Uppdateringar av själva skalet. Webbappen i fönstret uppdaterar sig med
// varje deploy (den visar "Ny version finns"); skalet ändras bara när
// desktop/ ändras. CI lägger då latest.json bredvid installationsfilerna
// (desktop/publish.sh). Hittas en nyare version frågar vi; "Uppdatera"
// laddar ner rätt fil till Hämtade filer och öppnar den. Inget installeras
// av sig självt och inget i appen laddas om, så ingen osparad data går förlorad.
'use strict'

const { app, dialog, net, shell } = require('electron')
const path = require('node:path')

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 15 * 1000

/** "1.10.0" > "1.9.2". Bara siffror, prerelease-taggar används inte. */
function isNewer(remote, local) {
  const a = String(remote).split('.').map(Number)
  const b = String(local).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

/** Nyckeln i latest.json för den här datorn. */
function platformKey() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (process.platform === 'win32') return 'win-x64'
  return process.env.APPIMAGE ? 'linux-appimage' : 'linux-deb'
}

function setUpUpdates({ baseUrl, getWindow }) {
  if (!baseUrl) return { checkNow: async () => {} }
  let askedFor = null
  let busy = false

  async function fetchLatest() {
    const res = await net.fetch(`${baseUrl}/latest.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`latest.json svarade ${res.status}`)
    return res.json()
  }

  function download(url) {
    const win = getWindow()
    if (!win) return void shell.openExternal(url)
    const ses = win.webContents.session
    const onDownload = (_e, item) => {
      if (item.getURL() !== url) return
      ses.removeListener('will-download', onDownload)
      const file = path.join(app.getPath('downloads'), item.getFilename())
      item.setSavePath(file)
      item.on('updated', () => {
        const total = item.getTotalBytes()
        if (total > 0 && !win.isDestroyed()) win.setProgressBar(item.getReceivedBytes() / total)
      })
      item.once('done', (_ev, state) => {
        if (!win.isDestroyed()) win.setProgressBar(-1)
        if (state !== 'completed') {
          void dialog.showMessageBox(win, {
            type: 'warning',
            message: 'Nedladdningen avbröts',
            detail: 'Försök igen senare, eller hämta filen i webbläsaren.',
            buttons: ['Öppna i webbläsaren', 'Stäng'],
          }).then(({ response }) => response === 0 && shell.openExternal(url))
          return
        }
        // macOS: skivavbilden öppnas, dra appen till Program. Windows: den
        // nya installationen startar och byter ut den gamla. Linux: .deb öppnas
        // i programhanteraren, en AppImage visas i sin mapp.
        if (process.env.APPIMAGE) shell.showItemInFolder(file)
        else void shell.openPath(file)
      })
    }
    ses.on('will-download', onDownload)
    ses.downloadURL(url)
  }

  async function check({ manual = false } = {}) {
    if (busy) return
    busy = true
    try {
      const latest = await fetchLatest()
      const win = getWindow()
      const current = app.getVersion()
      const url = latest?.files?.[platformKey()]
      if (!latest?.version || !url || !isNewer(latest.version, current)) {
        if (manual && win) {
          await dialog.showMessageBox(win, {
            type: 'info',
            message: 'Du har den senaste versionen',
            detail: `${app.getName()} ${current}`,
            buttons: ['OK'],
          })
        }
        return
      }
      if (!manual && askedFor === latest.version) return
      askedFor = latest.version
      if (!win) return
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        message: `Ny version av ${app.getName()}: ${latest.version}`,
        detail:
          `Du har ${current}. Uppdatera laddar ner installationsfilen och öppnar den. ` +
          'Appen fortsätter som vanligt tills du installerar, så inget osparat försvinner.',
        buttons: ['Uppdatera', 'Senare'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) download(url)
    } catch (err) {
      if (manual) {
        const win = getWindow()
        if (win) {
          await dialog.showMessageBox(win, {
            type: 'warning',
            message: 'Kunde inte söka efter uppdateringar',
            detail: 'Kontrollera internetanslutningen och försök igen.',
            buttons: ['OK'],
          })
        }
      } else {
        console.warn('[uppdatering]', err?.message ?? err)
      }
    } finally {
      busy = false
    }
  }

  setTimeout(() => void check(), FIRST_CHECK_MS)
  setInterval(() => void check(), CHECK_EVERY_MS)
  return { checkNow: () => check({ manual: true }) }
}

module.exports = { setUpUpdates, isNewer, platformKey }
