// Rena delar av skalet (ingen Electron här), så att node --test kan prova dem.
'use strict'

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * Sidan när nätet saknas. Mörk text på den ljusa bakgrunden (config.background)
 * och ljus text på mörk bakgrund när systemet är i mörkt läge. Inget skript,
 * egen strikt CSP och en vanlig länk tillbaka till appen.
 */
function offlineHtml({ appName, background, startUrl }) {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(appName)}</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:${background};color:#1c1918;
font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:26rem;padding:2rem;text-align:center}
h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0 0 1.5rem;opacity:.85}
a{display:inline-block;padding:.7rem 1.4rem;border-radius:3px;background:#1c1918;color:#fbfaf6;font-weight:700;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:#1c1918;color:#f6ece9}a{background:#fbfaf6;color:#1c1918}}
</style></head><body><main><h1>Ingen internetanslutning</h1>
<p>${esc(appName)} behöver internet. Kolla att wifi eller nätverkskabeln fungerar. Vi försöker igen av oss själva.</p>
<a href="${esc(startUrl)}">Försök igen</a></main></body></html>`
}

/**
 * Varje fönster glömmer sig självt när det stängs, också ett som öppnats på
 * nytt från Dock (macOS), så att menyval aldrig träffar ett förstört fönster.
 * Ett nyare fönster som redan tagit platsen lämnas kvar.
 */
function forgetOnClose(win, getCurrent, setCurrent) {
  win.on('closed', () => {
    if (getCurrent() === win) setCurrent(null)
  })
  return win
}

module.exports = { offlineHtml, forgetOnClose }
