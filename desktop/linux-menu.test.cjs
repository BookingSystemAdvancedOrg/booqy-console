// node --test (npm test i desktop/). Menyposten från install.sh får appens ikon.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { refreshMenuEntry } = require('./linux-menu.cjs')

function home({ desktop, icon }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booqy-menu-'))
  fs.mkdirSync(path.join(dir, '.local/share/applications'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.local/share/icons'), { recursive: true })
  const iconFile = path.join(dir, '.local/share/icons/booqy-console-dev.png')
  const desktopFile = path.join(dir, '.local/share/applications/booqy-console-dev.desktop')
  if (desktop) fs.writeFileSync(desktopFile, desktop(iconFile))
  if (icon) fs.writeFileSync(iconFile, icon)
  return { dir, iconFile, desktopFile }
}

const oldEntry = (iconFile) =>
  `[Desktop Entry]\nType=Application\nName=Booqy Console Dev\nExec="/x/booqy-console-dev.AppImage" %U\nIcon=${iconFile}\nTerminal=false\nCategories=Office;\n`
const args = (dir) => ({ home: dir, slug: 'booqy-console-dev', wmClass: 'booqy-console-dev', icon: Buffer.from('badged') })

test('an old install.sh entry gets the new icon and StartupWMClass', () => {
  const h = home({ desktop: oldEntry, icon: Buffer.from('plain') })
  assert.deepEqual(refreshMenuEntry(args(h.dir)), ['icon', 'desktop'])
  assert.equal(fs.readFileSync(h.iconFile, 'utf8'), 'badged')
  const text = fs.readFileSync(h.desktopFile, 'utf8')
  assert.match(text, /^Name=Booqy Console Dev\nStartupWMClass=booqy-console-dev\n/m)
  assert.equal(text.match(/StartupWMClass=/g).length, 1)
  assert.deepEqual(refreshMenuEntry(args(h.dir)), [], 'nothing to do the second time')
})

test('a missing icon file is written back', () => {
  const h = home({ desktop: oldEntry })
  assert.deepEqual(refreshMenuEntry(args(h.dir)), ['icon', 'desktop'])
  assert.equal(fs.readFileSync(h.iconFile, 'utf8'), 'badged')
})

test('no install.sh entry, or one pointing elsewhere: nothing is touched', () => {
  const none = home({ icon: Buffer.from('plain') })
  assert.deepEqual(refreshMenuEntry(args(none.dir)), [])
  assert.equal(fs.readFileSync(none.iconFile, 'utf8'), 'plain')
  const other = home({ desktop: () => '[Desktop Entry]\nName=Booqy Console Dev\nIcon=booqy-console-dev\n', icon: Buffer.from('plain') })
  assert.deepEqual(refreshMenuEntry(args(other.dir)), [])
  assert.equal(fs.readFileSync(other.iconFile, 'utf8'), 'plain')
})

test('a StartupWMClass no window has (the app name) is rewritten', () => {
  const withName = (iconFile) => oldEntry(iconFile).replace('Terminal=false', 'StartupWMClass=Booqy Console Dev\nTerminal=false')
  const h = home({ desktop: withName, icon: Buffer.from('badged') })
  assert.deepEqual(refreshMenuEntry(args(h.dir)), ['desktop'])
  const text = fs.readFileSync(h.desktopFile, 'utf8')
  assert.equal(text.match(/^StartupWMClass=.*$/gm).join(), 'StartupWMClass=booqy-console-dev')
  assert.match(text, /^Exec="\/x\/booqy-console-dev.AppImage" %U$/m, 'the rest of the entry is kept')
  assert.deepEqual(refreshMenuEntry(args(h.dir)), [])
})

test('install.sh writes the same StartupWMClass as the app (its file name)', () => {
  const sh = fs.readFileSync(path.join(__dirname, 'install', 'install.sh'), 'utf8')
  assert.match(sh, /^StartupWMClass=\$SLUG$/m)
  assert.match(sh, /^SLUG='__FILEBASE__'$/m)
  const build = fs.readFileSync(path.join(__dirname, 'build.mjs'), 'utf8')
  assert.match(build, /desktopName: `\$\{fileBase\}\.desktop`/)
  assert.match(build, /syncDesktopName: true/)
})
