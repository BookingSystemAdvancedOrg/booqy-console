// macOS-ikonen som Icon Composer-ikon (.icon), kompilerad till Assets.car.
//
// Varför: macOS 26 och senare ritar om vanliga .icns-ikoner i ikonstilen
// "Mörk": en ljus ruta blir svart och det svarta b:et syns knappt. En .icon
// där rutan är ett eget bildlager behåller sina färger i alla stilar, så att
// produktionsikonen ser ut exakt som utvecklingsikonen fast utan DEV.
//
// Körs för hand när logotypen ändras (kräver macOS med Xcode 26 eller senare):
//   node mac-icon.mjs
// Skriver build/mac/<prod|dev>/AppIcon.icon (källan) och Assets.car (det
// macOS läser). Båda checkas in; bygget i CI kopierar bara in Assets.car
// (build.mjs, afterPack), så CI behöver ingen Xcode.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import devIcon from './dev-icon.cjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const build = `${here}build`
const CANVAS = 1024

/** Rutans färg och b-märket ur build/icon.svg (samma källa som icon.png). */
export function partsOf(svg) {
  const tile = svg.match(/<rect[^>]*fill="(#[0-9a-fA-F]{6})"/)
  const mark = svg.match(/<svg[^>]*viewBox="([^"]+)"[^>]*>\s*<path fill="(#[0-9a-fA-F]{6})" d="([^"]+)"/)
  if (!tile || !mark) throw new Error('build/icon.svg: hittar inte rutan eller b-märket')
  return { tile: tile[1], viewBox: mark[1], mark: mark[2], d: mark[3] }
}

/** Bara DEV-brickan: de pixlar i rutan där dev-ikonen skiljer sig från produktionsikonen, i rutans storlek (icon.json skalar upp lagret till hela duken). */
export function badgeLayer(base) {
  const dev = devIcon.devIcon(base)
  const tile = devIcon.tileOf(base)
  const size = tile.size
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = ((tile.y + y) * base.width + tile.x + x) * 4
      const o = (y * size + x) * 4
      const same = dev.data[i] === base.data[i] && dev.data[i + 1] === base.data[i + 1] && dev.data[i + 2] === base.data[i + 2]
      if (same) continue
      data.set(dev.data.subarray(i, i + 3), o)
      data[o + 3] = 255
    }
  }
  return { ...base, width: size, height: size, data }
}

const layer = (name, scale) => ({
  layers: [{ 'image-name': name, name: name.replace(/\.\w+$/, ''), glass: false, ...(scale ? { position: { scale, 'translation-in-points': [0, 0] } } : {}) }],
  shadow: { kind: 'none', opacity: 0 },
  translucency: { enabled: false, value: 0 },
  specular: false,
})

/** icon.json: lagren uppifrån och ned (brickan, b:et, rutan). Ingen fyllning, så att macOS inte byter rutans färg. */
export function iconJson(badgeSize) {
  return {
    fill: 'none',
    groups: [...(badgeSize ? [layer('badge.png', CANVAS / badgeSize)] : []), layer('b.svg'), layer('tile.svg')],
    'supported-platforms': { squares: ['macOS'] },
  }
}

function write(env, parts, base) {
  const out = `${build}/mac/${env}`
  const icon = `${out}/AppIcon.icon`
  rmSync(out, { recursive: true, force: true })
  mkdirSync(`${icon}/Assets`, { recursive: true })
  writeFileSync(`${icon}/Assets/tile.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}"><rect width="${CANVAS}" height="${CANVAS}" fill="${parts.tile}"/></svg>\n`)
  writeFileSync(`${icon}/Assets/b.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="${parts.viewBox}"><path fill="${parts.mark}" d="${parts.d}"/></svg>\n`)
  const badge = env === 'dev' ? badgeLayer(base) : null
  if (badge) writeFileSync(`${icon}/Assets/badge.png`, devIcon.encodePng(badge))
  writeFileSync(`${icon}/icon.json`, JSON.stringify(iconJson(badge?.width), null, 2) + '\n')
  const tmp = `${out}/.actool`
  mkdirSync(tmp)
  execFileSync('xcrun', ['actool', icon, '--compile', tmp, '--platform', 'macosx', '--minimum-deployment-target', '11.0',
    '--app-icon', 'AppIcon', '--output-partial-info-plist', `${tmp}/partial.plist`], { stdio: ['ignore', 'ignore', 'inherit'] })
  writeFileSync(`${out}/Assets.car`, readFileSync(`${tmp}/Assets.car`))
  rmSync(tmp, { recursive: true, force: true })
  console.log(`build/mac/${env}/Assets.car`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parts = partsOf(readFileSync(`${build}/icon.svg`, 'utf8'))
  const base = devIcon.decodePng(readFileSync(`${build}/icon.png`))
  for (const env of ['prod', 'dev']) write(env, parts, base)
}
