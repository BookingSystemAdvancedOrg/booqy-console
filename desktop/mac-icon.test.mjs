// node --test mac-icon.test.mjs. Kör inte actool: kontrollerar att de incheckade
// Icon Composer-ikonerna (build/mac) stämmer med logotypen i build/icon.svg.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { iconJson, partsOf } from './mac-icon.mjs'

const here = new URL('./', import.meta.url)
const read = (p) => readFileSync(new URL(p, here), 'utf8')
const parts = partsOf(read('build/icon.svg'))

test('logotypens ruta och b-märke läses ur icon.svg', () => {
  assert.match(parts.tile, /^#[0-9a-f]{6}$/i)
  assert.match(parts.mark, /^#[0-9a-f]{6}$/i)
  assert.notEqual(parts.tile.toLowerCase(), parts.mark.toLowerCase())
  assert.ok(parts.d.length > 20)
})

for (const env of ['prod', 'dev']) {
  test(`${env}: Assets.car och .icon finns och följer icon.svg (kör node mac-icon.mjs om logotypen ändrats)`, () => {
    const dir = `build/mac/${env}`
    assert.ok(existsSync(new URL(`${dir}/Assets.car`, here)), `${dir}/Assets.car saknas`)
    assert.ok(read(`${dir}/AppIcon.icon/Assets/tile.svg`).includes(`fill="${parts.tile}"`))
    const b = read(`${dir}/AppIcon.icon/Assets/b.svg`)
    assert.ok(b.includes(`fill="${parts.mark}"`) && b.includes(parts.d) && b.includes(`viewBox="${parts.viewBox}"`))
    const json = JSON.parse(read(`${dir}/AppIcon.icon/icon.json`))
    // Ingen fyllning: då behåller macOS rutans färg i ikonstilen Mörk.
    assert.equal(json.fill, 'none')
    const names = json.groups.map((g) => g.layers[0]['image-name'])
    assert.deepEqual(names, env === 'dev' ? ['badge.png', 'b.svg', 'tile.svg'] : ['b.svg', 'tile.svg'])
  })
}

test('bara dev har DEV-brickan', () => {
  assert.equal(existsSync(new URL('build/mac/prod/AppIcon.icon/Assets/badge.png', here)), false)
  assert.equal(iconJson(undefined).groups.length, 2)
  assert.equal(iconJson(824).groups[0].layers[0].position.scale, 1024 / 824)
})

test('Mac-bygget kopierar in Assets.car och pekar ut den', () => {
  const build = read('build.mjs')
  assert.match(build, /afterPack/)
  assert.match(build, /build\/mac\/\$\{env\}\/Assets\.car/)
  assert.match(build, /CFBundleIconName: 'AppIcon'/)
})
