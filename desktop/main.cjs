// Booqys skrivbordsskal (Electron). Fönstret visar den deployade webbappen
// (dev eller prod) på dess riktiga https-adress, så inloggning, cookies,
// CORS och CloudFronts CSP fungerar exakt som i webbläsaren. Skalet lägger
// bara till fönster (genomskinligt glas), meny och spärrar: ingen Node i
// sidan, ingen egen preload, inga hemligheter. Se README.md i den här mappen.
'use strict'

const { app, BrowserWindow, Menu, dialog, nativeTheme, net, session, shell, systemPreferences } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const config = require('./desktop.config.json')
const { setUpUpdates } = require('./updates.cjs')
const target = readTarget()
const START_URL = new URL(target.url)
const ORIGIN = START_URL.origin
const IS_DEV_FLAVOR = target.env !== 'prod'
// "Booqy Admin" eller "Booqy Admin Dev", satt av build.mjs (productName).
const APP_NAME = app.getName()

// Bara de här behörigheterna, och bara för appens egen adress. Kameran
// behövs för biljettskanning (Insläpp), urklipp för kopiera-knapparna.
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'media',
  'notifications',
])

/** env.json skrivs av build.mjs; `npm start` utan den kör mot dev. */
function readTarget() {
  let built = null
  try {
    built = JSON.parse(fs.readFileSync(path.join(__dirname, 'env.json'), 'utf8'))
  } catch {
    /* inte byggd: npm start */
  }
  const env = built?.env ?? process.env.BOOQY_ENV ?? 'dev'
  let url = built?.url ?? config.urls[env]
  // Lokal utveckling mot en egen dev-server (t.ex. http://localhost:7070),
  // bara i opackade körningar så att en installerad app aldrig kan pekas om.
  if (!app.isPackaged && process.env.BOOQY_URL) url = process.env.BOOQY_URL
  if (!url) throw new Error(`Ingen adress för miljön "${env}" i desktop.config.json`)
  return { env, url }
}

function isAppUrl(raw) {
  try {
    return new URL(raw).origin === ORIGIN
  } catch {
    return false
  }
}

/** Länkar ut från appen öppnas i systemets webbläsare, aldrig i fönstret. */
function openOutside(raw) {
  try {
    const { protocol } = new URL(raw)
    if (protocol === 'https:' || protocol === 'mailto:' || protocol === 'tel:') {
      void shell.openExternal(raw)
    }
  } catch {
    /* ogiltig adress: gör ingenting */
  }
}

const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  devTools: IS_DEV_FLAVOR || !app.isPackaged,
  spellcheck: true,
}

// ---- Genomskinligt fönster (glas) ----------------------------------------
// Skrivbordet bakom fönstret syns igenom, mjukt suddigt:
// - macOS: systemets vibrancy (under-window), alltid aktiv.
// - Windows 11 22H2 och senare: akryl. Äldre Windows: helt fönster.
// - Linux: ingen pålitlig oskärpa, så ett genomskinligt fönster där webbsidan
//   lägger en tät ton bakom texten.
// Webbsidan får läget i user agent (BooqyGlass/<läge>) och sätter då
// .is-desktop-glass på <html>. Minskad genomskinlighet i systemet eller
// BOOQY_GLASS=off ger det vanliga, hela fönstret.
function glassMode() {
  if (process.env.BOOQY_GLASS === 'off') return 'none'
  if (nativeTheme.prefersReducedTransparency) return 'none'
  if (process.platform === 'darwin') return 'vibrancy'
  if (process.platform === 'win32') {
    const build = Number(os.release().split('.')[2] ?? 0)
    return build >= 22621 ? 'acrylic' : 'none'
  }
  if (process.platform === 'linux') return 'tint'
  return 'none'
}
const GLASS = glassMode()
const CLEAR = '#00000000'

function glassWindowOptions() {
  if (GLASS === 'vibrancy') {
    return { vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: CLEAR }
  }
  if (GLASS === 'acrylic') return { backgroundMaterial: 'acrylic', backgroundColor: CLEAR }
  if (GLASS === 'tint') return { transparent: true, backgroundColor: CLEAR }
  return { backgroundColor: config.background }
}

// Systemets glas följer appens ljusa eller mörka läge (data-glass-theme på
// <html>, annars data-theme), inte systemets, så att tonen och texten ovanpå
// alltid passar ihop. Sidan håller data-glass-theme kvar på det gamla läget
// tills svepet vid ett byte är klart (theme.ts). En
// MutationObserver i sidan svarar så fort attributet byts, så glaset byter i
// samma bildruta som sidan (förr var det en avläsning var 1,5 s, och då syntes
// den nya tonen en stund över det gamla glaset: grått, sedan ett ryck).
// Läses bara, inget skrivs till sidan.
const READ_THEME = `(document.documentElement.dataset.glassTheme || document.documentElement.dataset.theme || '')`
const WAIT_FOR_THEME = `new Promise((resolve) => {
  const el = document.documentElement
  const read = () => el.dataset.glassTheme || el.dataset.theme || ''
  const start = read()
  const done = () => { o.disconnect(); clearTimeout(t); resolve(read()) }
  const o = new MutationObserver(() => { if (read() !== start) done() })
  o.observe(el, { attributes: true, attributeFilter: ['data-theme', 'data-glass-theme'] })
  const t = setTimeout(done, 20000)
})`
function followPageTheme(win) {
  if (GLASS !== 'vibrancy' && GLASS !== 'acrylic') return
  const apply = (theme) => {
    const next = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system'
    if (nativeTheme.themeSource !== next) nativeTheme.themeSource = next
  }
  const ready = () => !win.isDestroyed() && isAppUrl(win.webContents.getURL())
  // Varje ny sidladdning startar en ny bevakning; en äldre slutar av sig själv.
  let generation = 0
  const watch = async () => {
    const mine = ++generation
    while (mine === generation && ready()) {
      try {
        const theme = await win.webContents.executeJavaScript(WAIT_FOR_THEME, false)
        if (mine === generation) apply(theme)
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }
  win.webContents.on('did-finish-load', () => {
    if (!ready()) return
    win.webContents
      .executeJavaScript(READ_THEME, false)
      .then(apply, () => {})
    void watch()
  })
}

// ---- Fönstrets storlek och läge sparas mellan körningar -----------------
const boundsFile = () => path.join(app.getPath('userData'), 'window.json')
function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile(), 'utf8'))
  } catch {
    return {}
  }
}
function saveBounds(win) {
  try {
    const data = { ...win.getNormalBounds(), maximized: win.isMaximized() }
    fs.writeFileSync(boundsFile(), JSON.stringify(data))
  } catch {
    /* inte viktigt */
  }
}

// ---- Sidan när nätet saknas ---------------------------------------------
// Ingen fil på disk och inget skript: en data-adress med egen strikt CSP och
// en vanlig länk tillbaka till appen. Skalet försöker också själv igen.
function offlinePage() {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(APP_NAME)}</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:${config.background};color:#f6ece9;
font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:26rem;padding:2rem;text-align:center}
h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0 0 1.5rem;opacity:.85}
a{display:inline-block;padding:.7rem 1.4rem;border-radius:3px;background:#fbfaf6;color:#1c1918;font-weight:700;text-decoration:none}
</style></head><body><main><h1>Ingen anslutning</h1>
<p>${esc(APP_NAME)} behöver internet. Vi försöker igen automatiskt så fort anslutningen är tillbaka.</p>
<a href="${esc(START_URL.href)}">Försök igen</a></main></body></html>`
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

let retryTimer = null
function showOffline(win) {
  void win.loadURL(offlinePage())
  clearInterval(retryTimer)
  retryTimer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(retryTimer)
    if (net.isOnline()) {
      clearInterval(retryTimer)
      void win.loadURL(START_URL.href)
    }
  }, 5000)
}

// ---- Inloggningen överlever omstart och uppdatering ------------------------
// Refresh-tokenen (30 dagar) ligger i en HttpOnly-cookie och byts vid varje
// förnyelse (rotation). Chromium skriver cookies till disk först efter en
// stund, så en ny token som bara fanns i minnet när appen stängdes (eller
// uppdaterades) skulle ge en utloggning vid nästa start. Därför skrivs
// cookie-lagret till disk så fort den cookien ändras och innan appen avslutas.
// Lagringen (userData) rensas aldrig, inte heller vid uppdatering.
const REFRESH_COOKIE = '__Secure-booqy_rt'
function flushCookies() {
  // localStorage (konsolens inloggning) skrivs också ut direkt.
  try {
    session.defaultSession.flushStorageData()
  } catch {
    /* finns inte i äldre Electron */
  }
  let flushed
  try {
    flushed = session.defaultSession.cookies.flushStore().catch(() => {})
  } catch {
    // Före ready finns ingen session; avslutet får aldrig fastna här.
    flushed = Promise.resolve()
  }
  return Promise.race([flushed, new Promise((resolve) => setTimeout(resolve, 1500))])
}
function keepSessionOnDisk() {
  session.defaultSession.cookies.on('changed', (_e, cookie) => {
    if (cookie.name === REFRESH_COOKIE) void flushCookies()
  })
}
let flushingForQuit = false
app.on('before-quit', (e) => {
  // En andra instans avslutas före ready: då finns inget att skriva, och
  // preventDefault skulle lämna en process utan fönster kvar.
  if (!app.isReady() || flushingForQuit) return
  e.preventDefault()
  flushingForQuit = true
  void flushCookies().then(() => {
    app.quit()
    // Avbröts avslutet (t.ex. osparade ändringar) skrivs det igen nästa gång.
    flushingForQuit = false
  })
})

let updates = null

// ---- Huvudfönstret --------------------------------------------------------
let mainWindow = null

function createWindow() {
  const saved = loadBounds()
  const win = new BrowserWindow({
    width: saved.width ?? 1280,
    height: saved.height ?? 840,
    x: saved.x,
    y: saved.y,
    minWidth: 360,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    ...glassWindowOptions(),
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: secureWebPreferences,
  })
  if (saved.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  win.on('close', () => saveBounds(win))
  followPageTheme(win)

  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // -3 = avbruten (t.ex. ny navigering), inget fel att visa.
    if (isMainFrame && code !== -3 && isAppUrl(url)) showOffline(win)
  })

  void win.loadURL(START_URL.href)
  return win
}

// ---- Spärrar för allt innehåll i alla fönster ---------------------------
const LEAVE_DEFAULT = {
  message: 'Lämna sidan?',
  detail: 'Osparade ändringar försvinner.',
  leave: 'Lämna',
  stay: 'Stanna',
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())

  // Navigering i fönstret: bara inom appen (och tillbaka från offlinesidan).
  contents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    // Uppdateringsrutans knapp (updates.cjs): booqy-shell://restart eller /download.
    if (url.startsWith('booqy-shell://')) {
      updates?.handleAction(url.slice('booqy-shell://'.length).replace(/\/$/, ''))
      return
    }
    openOutside(url)
  })
  // En sida som spärrar omladdning eller stängning (beforeunload, t.ex. osparade
  // ändringar) får här en riktig fråga. Utan den avbryter Electron tyst och
  // appen ser ut att hänga (som "Laddar om..." efter en ny version).
  contents.on('will-prevent-unload', (e) => {
    const leave = { ...LEAVE_DEFAULT, ...config.leave }
    const win = BrowserWindow.fromWebContents(contents)
    const options = {
      type: 'question',
      buttons: [leave.leave, leave.stay],
      defaultId: 0,
      cancelId: 1,
      message: leave.message,
      detail: leave.detail,
    }
    const choice = win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options)
    if (choice === 0) e.preventDefault()
  })
  contents.on('will-redirect', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    openOutside(url)
  })

  contents.setWindowOpenHandler(({ url }) => {
    // Utskrifter (affisch, QR) öppnar ett tomt fönster och skriver i det;
    // Cmd/Ctrl-klick på en rad i konsolen öppnar en sida i appen.
    if (url === '' || url === 'about:blank' || isAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#fdfaf6',
          webPreferences: secureWebPreferences,
        },
      }
    }
    openOutside(url)
    return { action: 'deny' }
  })
})

function setUpPermissions() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ok = ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl ?? wc.getURL())
    if (!ok) return callback(false)
    if (permission === 'media' && process.platform === 'darwin') {
      // macOS frågar en gång per app; utan ja ger kameran svart bild.
      systemPreferences
        .askForMediaAccess('camera')
        .then(callback)
        .catch(() => callback(false))
      return
    }
    callback(true)
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && requestingOrigin === ORIGIN
  })
  ses.setUserAgent(`${ses.getUserAgent()} BooqyDesktop/${app.getVersion()} BooqyGlass/${GLASS}`)
}

// ---- Meny på svenska ------------------------------------------------------
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const view = [
    { role: 'reload', label: 'Ladda om' },
    { role: 'forceReload', label: 'Ladda om helt' },
    ...(secureWebPreferences.devTools ? [{ role: 'toggleDevTools', label: 'Utvecklarverktyg' }] : []),
    { type: 'separator' },
    { role: 'resetZoom', label: 'Faktisk storlek' },
    { role: 'zoomIn', label: 'Zooma in' },
    { role: 'zoomOut', label: 'Zooma ut' },
    { type: 'separator' },
    { role: 'togglefullscreen', label: 'Helskärm' },
  ]
  const template = [
    ...(isMac
      ? [{
          label: APP_NAME,
          submenu: [
            { role: 'about', label: `Om ${APP_NAME}` },
            { type: 'separator' },
            { role: 'hide', label: `Göm ${APP_NAME}` },
            { role: 'hideOthers', label: 'Göm övriga' },
            { role: 'unhide', label: 'Visa alla' },
            { type: 'separator' },
            { role: 'quit', label: `Avsluta ${APP_NAME}` },
          ],
        }]
      : [{ label: 'Arkiv', submenu: [{ role: 'quit', label: 'Avsluta' }] }]),
    {
      label: 'Redigera',
      submenu: [
        { role: 'undo', label: 'Ångra' },
        { role: 'redo', label: 'Gör om' },
        { type: 'separator' },
        { role: 'cut', label: 'Klipp ut' },
        { role: 'copy', label: 'Kopiera' },
        { role: 'paste', label: 'Klistra in' },
        { role: 'selectAll', label: 'Markera allt' },
      ],
    },
    { label: 'Visa', submenu: view },
    {
      label: 'Fönster',
      submenu: [
        { role: 'minimize', label: 'Minimera' },
        { role: 'zoom', label: 'Zooma' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: 'Lägg alla överst' }] : [{ role: 'close', label: 'Stäng' }]),
      ],
    },
    {
      label: 'Hjälp',
      submenu: [
        { label: 'Sök efter uppdateringar...', click: () => void updates?.checkNow() },
        { label: 'Öppna i webbläsaren', click: () => openOutside(mainWindow?.webContents.getURL() || START_URL.href) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- Start ----------------------------------------------------------------
app.enableSandbox()
app.setAboutPanelOptions({ applicationName: APP_NAME, copyright: 'Booqy' })

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    setUpPermissions()
    keepSessionOnDisk()
    buildMenu()
    mainWindow = createWindow()
    // Nya versioner av skalet (latest.json bredvid installationsfilerna).
    updates = setUpUpdates({ baseUrl: config.downloads?.[target.env], getWindow: () => mainWindow, flush: flushCookies })
    mainWindow.on('closed', () => (mainWindow = null))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
