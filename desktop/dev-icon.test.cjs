// node --test (npm test i desktop/). Testar DEV-brickan på utvecklingsbyggets
// ikon mot den riktiga produktionsikonen (build/icon.png): att produktion
// lämnas orörd, att brickan sitter där den ska och inte rör logotypen, och att
// utvecklingsbygget får alla storlekar.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const icon = require('./dev-icon.cjs')

const BUILD = path.join(__dirname, 'build')
const base = icon.decodePng(fs.readFileSync(path.join(BUILD, 'icon.png')))
const tile = icon.tileOf(base)
const colours = icon.coloursOf(base)

const pixel = (img, x, y) => [...img.data.subarray((Math.round(y) * img.width + Math.round(x)) * 4, (Math.round(y) * img.width + Math.round(x)) * 4 + 4)]
const rgb = (img, x, y) => pixel(img, x, y).slice(0, 3)

/** Linux-uppsättningens filer (inte .DS_Store och annat som Finder lägger dit). */
const setNames = () => fs.readdirSync(path.join(BUILD, 'icons')).filter((n) => /^(\d+)x\1\.png$/.test(n)).sort()

/** En kopia av desktop/build (ikonen och Linux-uppsättningen) i en tillfällig mapp. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booqy-dev-icon-'))
  fs.mkdirSync(path.join(dir, 'build', 'icons'), { recursive: true })
  fs.copyFileSync(path.join(BUILD, 'icon.png'), path.join(dir, 'build', 'icon.png'))
  for (const name of setNames()) {
    fs.copyFileSync(path.join(BUILD, 'icons', name), path.join(dir, 'build', 'icons', name))
  }
  return dir
}

test('a PNG survives decode and encode unchanged', () => {
  const again = icon.decodePng(icon.encodePng(base))
  assert.equal(again.width, base.width)
  assert.equal(again.height, base.height)
  assert.ok(Buffer.from(again.data).equals(Buffer.from(base.data)), 'the pixels changed in the round trip')
  assert.deepEqual(again.colour, base.colour)
})

test('decodePng reads every PNG row filter and RGB without alpha', () => {
  // The committed Linux set comes from other tools (sips), with other filters and chunks.
  for (const name of setNames()) {
    const size = Number(/^(\d+)x/.exec(name)[1])
    const img = icon.decodePng(fs.readFileSync(path.join(BUILD, 'icons', name)))
    assert.equal(img.width, size, name)
    assert.equal(img.data.length, size * size * 4, name)
  }
  assert.throws(() => icon.decodePng(Buffer.from('not a png at all')), /Not a PNG/)
})

test('the production icon is a square tile with two clearly different colours', () => {
  assert.equal(base.width, 1024)
  assert.equal(base.height, 1024)
  assert.ok(tile.size > 700 && tile.size <= 1024, `tile ${tile.size}`)
  assert.notDeepEqual(colours.tile, colours.mark)
})

test('production builds use the committed icon and nothing is generated', () => {
  const dir = sandbox()
  try {
    assert.deepEqual(icon.iconsFor('prod', dir), { app: 'build/icon.png', win: 'build/icon.png', set: 'build/icons' })
    assert.equal(fs.existsSync(path.join(dir, 'build', 'dev')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the dev icon is the production icon plus a pill in the top right corner', () => {
  const dev = icon.devIcon(base)
  const { box } = icon.badgeShape(tile)
  assert.equal(dev.width, base.width)
  let changed = 0
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      const i = (y * base.width + x) * 4
      // Transparency never changes: the outline of the icon is the same.
      assert.equal(dev.data[i + 3], base.data[i + 3])
      const same = dev.data[i] === base.data[i] && dev.data[i + 1] === base.data[i + 1] && dev.data[i + 2] === base.data[i + 2]
      if (same) continue
      changed++
      assert.ok(x >= Math.floor(box.x0) && x <= Math.ceil(box.x1) && y >= Math.floor(box.y0) && y <= Math.ceil(box.y1), `pixel ${x},${y} changed outside the badge`)
    }
  }
  assert.ok(changed > 10000, 'the badge is drawn')
  // Top right: right of the middle, in the upper third, inside the tile.
  assert.ok(box.x0 > tile.x + tile.size / 2 - tile.size * 0.05)
  assert.ok(box.y1 < tile.y + tile.size / 3)
  assert.ok(box.x1 < tile.x + tile.size && box.y0 > tile.y)
})

test('the pill has the mark\'s colour and the letters the tile\'s colour', () => {
  const dev = icon.devIcon(base)
  const shape = icon.badgeShape(tile)
  // Just inside the pill's left end: pill colour, no letter there.
  assert.deepEqual(rgb(dev, shape.pill.ax - shape.pill.r * 0.5, shape.pill.y), colours.mark)
  // On the stems of D and E and the point of V: the tile's colour.
  for (const [x0, y0, x1, y1] of [shape.segments[0], shape.segments[3]]) {
    assert.deepEqual(rgb(dev, (x0 + x1) / 2, (y0 + y1) / 2), colours.tile)
  }
  const [, , vx, vy] = shape.segments[7]
  assert.deepEqual(rgb(dev, vx, vy - shape.stroke * 0.5), colours.tile)
  // Between the letters the pill shows through.
  const gap = (shape.segments[1][2] + shape.arc.r + shape.segments[3][0]) / 2
  assert.deepEqual(rgb(dev, gap, shape.pill.y), colours.mark)
})

test('the badge sits on plain tile, clear of the logo and of the rounded corner', () => {
  // Everything under the pill, plus a margin, is tile colour in the production
  // icon. Fails if the logo is redrawn so that the badge would cover part of it.
  const { box } = icon.badgeShape(tile)
  const margin = Math.round(tile.size * 0.02)
  for (let y = Math.floor(box.y0) - margin; y <= Math.ceil(box.y1) + margin; y++) {
    for (let x = Math.floor(box.x0) - margin; x <= Math.ceil(box.x1) + margin; x++) {
      const p = pixel(base, x, y)
      // Beyond the tile's rounded corner the icon is transparent. That is fine for the
      // margin; the pill itself must be on the tile, which devIcon checks below.
      if (p[3] !== 255) continue
      assert.deepEqual(p.slice(0, 3), colours.tile, `logo pixel at ${x},${y} is too close to the badge`)
    }
  }
  // strict: devIcon throws if any part of the pill is off the tile.
  assert.doesNotThrow(() => icon.devIcon(base))
})

test('small sizes get a plain pill, larger sizes the letters', () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const dev = icon.devIcon(base, size)
    assert.equal(dev.width, size)
    assert.equal(dev.data.length, size * size * 4)
    const k = size / base.width
    const shape = icon.badgeShape({ x: tile.x * k, y: tile.y * k, size: tile.size * k })
    // Count pixels inside the pill that are closer to the tile's colour than to the mark's: the letters.
    let ink = 0
    for (let y = Math.floor(shape.box.y0); y <= Math.ceil(shape.box.y1); y++) {
      for (let x = Math.ceil(shape.pill.ax); x < Math.floor(shape.pill.bx); x++) {
        if (Math.abs(y + 0.5 - shape.pill.y) > shape.pill.r * 0.6) continue
        const p = rgb(dev, x, y)
        const toTile = Math.abs(p[0] - colours.tile[0])
        const toMark = Math.abs(p[0] - colours.mark[0])
        if (toTile < toMark) ink++
      }
    }
    if (size < 64) assert.equal(ink, 0, `${size} px should be a plain pill`)
    else assert.ok(ink > 0, `${size} px should show the letters`)
  }
})

test('downscaling keeps the tile\'s colour up to its edge (no dark fringe)', () => {
  const small = icon.resize(base, 64)
    // The half-covered pixels along the tile's edge keep the tile's colour.
  let edge = 0
  for (let i = 0; i < small.data.length; i += 4) {
    const a = small.data[i + 3]
    if (a === 0 || a === 255) continue
    edge++
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(small.data[i + c] - colours.tile[c]) <= 2, 'dark fringe on the tile edge')
  }
  assert.ok(edge > 50)
  assert.equal(pixel(small, 0, 0)[3], 0)
  assert.throws(() => icon.resize(base, 2048), /too small/)
})

test('dev builds get the icon and the whole Linux set, with the badge', () => {
  const dir = sandbox()
  try {
    const icons = icon.iconsFor('dev', dir)
    assert.deepEqual(icons, { app: 'build/dev/icon.png', win: 'build/dev/icon.ico', set: 'build/dev/icons' })
    const made = fs.readdirSync(path.join(dir, 'build', 'dev', 'icons')).sort()
    assert.deepEqual(made, setNames())
    for (const name of made) {
      const size = Number(/^(\d+)x/.exec(name)[1])
      const img = icon.decodePng(fs.readFileSync(path.join(dir, 'build', 'dev', 'icons', name)))
      assert.equal(img.width, size, name)
      assert.equal(img.height, size, name)
      assert.ok(Buffer.from(img.data).equals(Buffer.from(icon.devIcon(base, size).data)), `${name} is not the badged icon`)
    }
    const app = icon.decodePng(fs.readFileSync(path.join(dir, icons.app)))
    assert.ok(Buffer.from(app.data).equals(Buffer.from(icon.devIcon(base).data)), 'build/dev/icon.png is not the badged icon')
    // The production files in the same folder are untouched.
    for (const rel of ['icon.png', ...setNames().map((n) => path.join('icons', n))]) {
      assert.ok(fs.readFileSync(path.join(dir, 'build', rel)).equals(fs.readFileSync(path.join(BUILD, rel))), `${rel} changed`)
    }
    // Windows: one .ico with a badged PNG per size.
    const ico = fs.readFileSync(path.join(dir, icons.win))
    assert.equal(ico.readUInt16LE(4), icon.ICO_SIZES.length)
    icon.ICO_SIZES.forEach((size, i) => {
      const at = 6 + 16 * i
      assert.equal(ico[at] || 256, size)
      const frame = icon.decodePng(ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8)))
      assert.ok(Buffer.from(frame.data).equals(Buffer.from(icon.devIcon(base, size).data)), `ico ${size}`)
    })
    // A second run replaces the folder instead of failing or piling up files.
    assert.deepEqual(icon.iconsFor('dev', dir), icons)
    assert.deepEqual(fs.readdirSync(path.join(dir, 'build', 'dev', 'icons')).sort(), made)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('decodePng undoes each row filter, for RGBA and for RGB without alpha', () => {
  const zlib = require('node:zlib')
  const W = 16
  const H = 12
  for (const channels of [4, 3]) {
    for (let filter = 0; filter <= 4; filter++) {
      const px = Buffer.alloc(W * H * channels)
      for (let i = 0; i < px.length; i++) px[i] = (i * 37 + filter * 11 + (i >> 3)) & 0xff
      const stride = W * channels
      const raw = Buffer.alloc((stride + 1) * H)
      for (let y = 0; y < H; y++) {
        raw[y * (stride + 1)] = filter
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? px[y * stride + x - channels] : 0
          const b = y > 0 ? px[(y - 1) * stride + x] : 0
          const c = y > 0 && x >= channels ? px[(y - 1) * stride + x - channels] : 0
          const p = a + b - c
          const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
          const predicted = [0, a, b, (a + b) >> 1, paeth][filter]
          raw[y * (stride + 1) + 1 + x] = (px[y * stride + x] - predicted) & 0xff
        }
      }
      const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
        const out = Buffer.alloc(body.length + 8)
        out.writeUInt32BE(data.length, 0)
        body.copy(out, 4)
        out.writeUInt32BE(zlib.crc32(body), body.length + 4)
        return out
      }
      const ihdr = Buffer.alloc(13)
      ihdr.writeUInt32BE(W, 0)
      ihdr.writeUInt32BE(H, 4)
      ihdr[8] = 8
      ihdr[9] = channels === 4 ? 6 : 2
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
      const img = icon.decodePng(png)
      for (let i = 0; i < W * H; i++) {
        for (let c = 0; c < 3; c++) assert.equal(img.data[i * 4 + c], px[i * channels + c], `filter ${filter}, ${channels} channels`)
        assert.equal(img.data[i * 4 + 3], channels === 4 ? px[i * 4 + 3] : 255)
      }
    }
  }
  // What encodePng writes has valid checksums.
  const out = icon.encodePng(icon.devIcon(base, 64))
  for (let at = 8; at < out.length; ) {
    const n = out.readUInt32BE(at)
    assert.equal(out.readUInt32BE(at + 8 + n), zlib.crc32(out.subarray(at + 4, at + 8 + n)))
    at += 12 + n
  }
})

test('the letters have their shapes: the bowl of D, the bar of E, an arm of V', () => {
  const dev = icon.devIcon(base)
  const shape = icon.badgeShape(tile)
  assert.deepEqual(rgb(dev, shape.arc.cx + shape.arc.r, shape.arc.cy), colours.tile)
  const [ex0, ey, ex1] = shape.segments[6]
  assert.deepEqual(rgb(dev, (ex0 + ex1) / 2, ey), colours.tile)
  const [vx0, vy0, vx1, vy1] = shape.segments[8]
  assert.deepEqual(rgb(dev, (vx0 + vx1) / 2, (vy0 + vy1) / 2), colours.tile)
})

test('the pill keeps clear of the rounder corner macOS draws', () => {
  // From the pill's rounded end to the PNG's own corner arc, along the diagonal: at least 4 % of the tile.
  const { pill } = icon.badgeShape(tile)
  const radius = (tile.size * 185) / 824
  const cx = tile.x + tile.size - radius
  const cy = tile.y + radius
  const gap = radius - (Math.hypot(pill.bx - cx, pill.y - cy) + pill.r)
  assert.ok(gap >= tile.size * 0.04, `only ${gap.toFixed(1)} px to the corner`)
})

test('build.mjs and publish.mjs take every icon from iconsFor', () => {
  const build = fs.readFileSync(path.join(__dirname, 'build.mjs'), 'utf8')
  assert.ok(build.includes('const icons = devIcon.iconsFor(env)'))
  assert.deepEqual(build.match(/^ *icon: .*$/gm).map((l) => l.trim()), ['icon: icons.app,', 'icon: icons.win,', 'icon: icons.set,'])
  const publish = fs.readFileSync(path.join(__dirname, 'publish.mjs'), 'utf8')
  assert.match(publish, /devIcon\.iconsFor\(values\.env\)\.set\}\/256x256\.png/)
  assert.ok(!publish.includes("'./build/icons/"))
})
