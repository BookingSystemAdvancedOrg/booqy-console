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
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Rör bara en menypost som install.sh skapat: filen finns och dess Icon= pekar
 * på skriptets ikonfil. Returnerar vad som ändrades.
 */
function refreshMenuEntry({ home, slug, wmClass, icon }) {
  const changed = []
  const desktopFile = path.join(home, '.local', 'share', 'applications', `${slug}.desktop`)
  const iconFile = path.join(home, '.local', 'share', 'icons', `${slug}.png`)
  let text
  try {
    text = fs.readFileSync(desktopFile, 'utf8')
  } catch {
    return changed
  }
  if (!text.split('\n').some((line) => line.trim() === `Icon=${iconFile}`)) return changed
  let current = null
  try {
    current = fs.readFileSync(iconFile)
  } catch {
    /* saknas: skrivs nedan */
  }
  if (!current || !current.equals(icon)) {
    fs.writeFileSync(iconFile, icon)
    changed.push('icon')
  }
  if (wmClass && !text.split('\n').some((line) => line.trim() === `StartupWMClass=${wmClass}`)) {
    const next = /^StartupWMClass=.*$/m.test(text)
      ? text.replace(/^StartupWMClass=.*$/m, `StartupWMClass=${wmClass}`)
      : text.replace(/^Name=.*$/m, (line) => `${line}\nStartupWMClass=${wmClass}`)
    fs.writeFileSync(desktopFile, next)
    changed.push('desktop')
  }
  return changed
}

module.exports = { refreshMenuEntry }
