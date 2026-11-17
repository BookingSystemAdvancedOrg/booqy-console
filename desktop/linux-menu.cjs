// Linux, installerad med install.sh: menyns ikon är en kopia som skriptet
// laddade ner en gång (~/.local/share/icons/<slug>.png). AppImagen uppdaterar
// sig själv, men den kopian och .desktop-filen ligger kvar som de var. En
// installation från före DEV-brickan visade därför fortfarande den rena
// logotypen i menyn och dockan. Appen rättar dem själv vid start: samma ikon
// som fönstret (dev med DEV-brickan, prod utan) och StartupWMClass, så att
// skrivbordet kopplar fönstret till menyposten. StartupWMClass ska vara det
// namn Electron ger fönstret: desktopName utan ".desktop" (build.mjs sätter
// den till filnamnet, t.ex. booqy-console-dev), som WM_CLASS under X11 och
// app_id under Wayland. Står ett annat namn där skrivs raden om. Ren Node,
// testas med `node --test` (linux-menu.test.cjs).
// Menyn tar sedan rätt storlek ur ~/.local/share/icons/hicolor (Icon= blir
// temanamnet), inte en nerskalad 512-bild där DEV inte gick att läsa i 24
// till 48 px.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Rad som visar att Icon= bytts mot temanamnet av appen (se nedan).
const THEMED = 'X-Booqy-Icons=hicolor'

function writeIfChanged(file, data) {
  let current = null
  try {
    current = fs.readFileSync(file)
  } catch {
    /* saknas: skrivs nedan */
  }
  if (current && current.equals(data)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  return true
}

/**
 * Ikonuppsättningen i AppImagen ($APPDIR/usr/share/icons/hicolor), som
 * { '48x48': Buffer, ... }. Tom om den saknas.
 */
function readIconSet(appDir, slug) {
  const set = {}
  const root = path.join(appDir || '', 'usr', 'share', 'icons', 'hicolor')
  let dirs = []
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return set
  }
  for (const dir of dirs) {
    if (!/^\d+x\d+$/.test(dir)) continue
    try {
      set[dir] = fs.readFileSync(path.join(root, dir, 'apps', `${slug}.png`))
    } catch {
      /* storleken saknas: hoppa över */
    }
  }
  return set
}

/**
 * Rör bara en menypost som install.sh skapat: filen finns och dess Icon= pekar
 * på skriptets ikonfil, eller på temanamnet med THEMED-raden (en post som
 * appen redan bytt). Med iconSet läggs varje storlek i
 * ~/.local/share/icons/hicolor och Icon= blir temanamnet, så att menyn,
 * dockan och aktivitetsfältet tar den ritade storleken (DEV läsbar i 24 till
 * 48 px) i stället för att skala ner en stor bild. Returnerar vad som ändrades.
 */
function refreshMenuEntry({ home, slug, wmClass, icon, iconSet = {} }) {
  const changed = []
  const share = path.join(home, '.local', 'share')
  const desktopFile = path.join(share, 'applications', `${slug}.desktop`)
  const iconFile = path.join(share, 'icons', `${slug}.png`)
  let text
  try {
    text = fs.readFileSync(desktopFile, 'utf8')
  } catch {
    return changed
  }
  const has = (want) => text.split('\n').some((line) => line.trim() === want)
  const legacy = has(`Icon=${iconFile}`)
  const themed = has(`Icon=${slug}`) && has(THEMED)
  if (!legacy && !themed) return changed
  if (icon && writeIfChanged(iconFile, icon)) changed.push('icon')
  const sizes = Object.keys(iconSet).filter((size) => /^\d+x\d+$/.test(size))
  if (sizes.length) {
    const hicolor = path.join(share, 'icons', 'hicolor')
    let wrote = false
    for (const size of sizes) {
      if (writeIfChanged(path.join(hicolor, size, 'apps', `${slug}.png`), iconSet[size])) wrote = true
    }
    if (wrote) {
      // Ny mtime på temamappen: GTK läser om den i stället för en gammal cache.
      const now = new Date()
      fs.utimesSync(hicolor, now, now)
      changed.push('icons')
    }
  }
  let next = text
  if (legacy && sizes.length) next = next.replace(/^Icon=.*$/m, `Icon=${slug}\n${THEMED}`)
  if (wmClass && !has(`StartupWMClass=${wmClass}`)) {
    next = /^StartupWMClass=.*$/m.test(next)
      ? next.replace(/^StartupWMClass=.*$/m, `StartupWMClass=${wmClass}`)
      : next.replace(/^Name=.*$/m, (line) => `${line}\nStartupWMClass=${wmClass}`)
  }
  if (next !== text) {
    fs.writeFileSync(desktopFile, next)
    changed.push('desktop')
  }
  return changed
}

module.exports = { refreshMenuEntry, readIconSet, THEMED }
