// DEV-brickan på utvecklingsbyggets appikon. Ren logik utan Electron och utan
// andra paket än Node, så att den går att testa med `node --test`
// (dev-icon.test.cjs). build.mjs och publish.mjs använder den.
//
// Produktionsbygget använder build/icon.png och build/icons/ som de är: där
// ska ingenting stå på ikonen. Utvecklingsbygget ("... Dev") får samma ikon
// med en bricka "DEV" uppe till höger, så att de två apparna går att skilja
// åt i Dock och aktivitetsfält. Brickan ritas på produktionsikonen varje gång
// bygget körs (till build/dev/, som inte checkas in), så det finns inga extra
// bildfiler som kan hamna i otakt med logotypen.
//
// Brickan har ikonens egna två färger, omvända: märkets färg som botten och
// rutans färg som text. Då håller den sig till de två tillåtna logotyperna
// (svart ruta med benvitt b, benvit ruta med svart b), och macOS mörka
// ikonstil låter den ljusa ikonen vara ljus (se README.md, "App icon").
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// ---------------------------------------------------------------- PNG

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Färguppgifter som följer med till den nya filen, så att färgerna visas som i originalet. */
const COLOUR_CHUNKS = ['sRGB', 'gAMA', 'cHRM', 'iCCP']

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Läser en PNG till RGBA. Klarar det ikonerna är sparade som: 8 bitar per
 * kanal, RGB eller RGBA, inte sammanflätad. Allt annat ger ett tydligt fel.
 */
function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file')
  let width = 0
  let height = 0
  let channels = 0
  const idat = []
  const colour = []
  for (let at = 8; at + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colourType = data[9]
      const interlace = data[12]
      if (depth !== 8 || (colourType !== 6 && colourType !== 2) || interlace !== 0) {
        throw new Error(
          `Unsupported PNG (depth ${depth}, colour type ${colourType}, interlace ${interlace}): save the icon as 8-bit RGB or RGBA, not interlaced`,
        )
      }
      channels = colourType === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    else if (COLOUR_CHUNKS.includes(type)) colour.push({ type, data: Buffer.from(data) })
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (!width || !height || idat.length === 0) throw new Error('PNG without image data')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length !== (stride + 1) * height) throw new Error('PNG image data has the wrong size')
  const rows = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[dst + x - channels] : 0
      const up = y > 0 ? rows[dst + x - stride] : 0
      const upLeft = y > 0 && x >= channels ? rows[dst + x - stride - channels] : 0
      let v = raw[src + x]
      if (filter === 1) v += left
      else if (filter === 2) v += up
      else if (filter === 3) v += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}`)
      rows[dst + x] = v & 0xff
    }
  }
  const data = new Uint8Array(width * height * 4)
  if (channels === 4) data.set(rows)
  else {
    for (let i = 0, o = 0; i < rows.length; i += 3, o += 4) {
      data[o] = rows[i]
      data[o + 1] = rows[i + 1]
      data[o + 2] = rows[i + 2]
      data[o + 3] = 255
    }
  }
  return { width, height, data, colour }
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Skriver RGBA som PNG (8 bitar, RGBA). Raderna lagras som skillnaden mot raden ovanför: enfärgade ytor blir små. */
function encodePng({ width, height, data, colour = [] }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1)
    raw[dst] = y === 0 ? 0 : 2
    for (let x = 0; x < stride; x++) {
      const v = data[y * stride + x]
      raw[dst + 1 + x] = y === 0 ? v : (v - data[(y - 1) * stride + x]) & 0xff
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    ...colour.map((c) => chunk(c.type, c.data)),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- bilden

/** Vilka källpixlar en målpixel täcker längs en axel, med vikter (medelvärde över ytan). */
function spans(from, to) {
  const ratio = from / to
  const out = []
  for (let d = 0; d < to; d++) {
    const start = d * ratio
    const end = (d + 1) * ratio
    const list = []
    for (let s = Math.floor(start); s < Math.min(from, Math.ceil(end)); s++) {
      const weight = (Math.min(end, s + 1) - Math.max(start, s)) / ratio
      if (weight > 0) list.push([s, weight])
    }
    out.push(list)
  }
  return out
}

/**
 * Förminskar en kvadratisk bild med medelvärde över ytan. Färgerna vägs med
 * sin täckning (förmultiplicerad alfa), annars får rutans rundade kant en mörk rand.
 */
function resize(img, size) {
  if (img.width !== img.height) throw new Error('The icon must be square')
  if (size > img.width) throw new Error(`The icon is ${img.width} px: too small for a ${size} px version`)
  if (size === img.width) return { ...img, data: new Uint8Array(img.data) }
  const n = img.width
  const weights = spans(n, size)
  // Vågrätt: n rader, size kolumner, förmultiplicerat.
  const mid = new Float64Array(n * size * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const [s, w] of weights[x]) {
        const i = (y * n + s) * 4
        const alpha = (img.data[i + 3] / 255) * w
        r += img.data[i] * alpha
        g += img.data[i + 1] * alpha
        b += img.data[i + 2] * alpha
        a += alpha
      }
      const o = (y * size + x) * 4
      mid[o] = r
      mid[o + 1] = g
      mid[o + 2] = b
      mid[o + 3] = a
    }
  }
  // Lodrätt, och tillbaka till vanlig (inte förmultiplicerad) färg.
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const [s, w] of weights[y]) {
        const i = (s * size + x) * 4
        r += mid[i] * w
        g += mid[i + 1] * w
        b += mid[i + 2] * w
        a += mid[i + 3] * w
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        data[o] = Math.round(r / a)
        data[o + 1] = Math.round(g / a)
        data[o + 2] = Math.round(b / a)
      }
      data[o + 3] = Math.round(a * 255)
    }
  }
  return { ...img, width: size, height: size, data }
}

/** Ikonrutan: det som inte är genomskinligt (macOS-ikonen har luft runt rutan). */
function tileOf(img) {
  let x0 = img.width
  let y0 = img.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] < 128) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) throw new Error('The icon is fully transparent')
  return { x: x0, y: y0, size: Math.max(x1 - x0, y1 - y0) + 1 }
}

/**
 * Ikonens två färger: rutans (den vanligaste) och märkets (den näst
 * vanligaste). Kantpixlarna däremellan är för få för att räknas.
 */
function coloursOf(img) {
  const counts = new Map()
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] !== 255) continue
    const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
  if (top.length < 2) throw new Error('The icon needs two colours: a tile and a mark')
  const rgb = (key) => [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff]
  const tile = rgb(top[0][0])
  const mark = rgb(top[1][0])
  const light = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  if (Math.abs(light(tile) - light(mark)) < 96) {
    throw new Error('The icon\'s tile and mark are too close in lightness for a readable DEV badge')
  }
  return { tile, mark }
}

// ---------------------------------------------------------------- brickan

/** Brickans mått som delar av rutans sida: avstånd till kanten, bredd, höjd. */
// Avståndet räcker också till det rundare hörn macOS 26 och senare ritar i Dock.
const BADGE = { inset: 0.065, width: 0.48, height: 0.2136 }
/** Under den här storleken (px) ritas brickan utan bokstäver: de blir bara grus (Linux-uppsättningen och Windows .ico; macOS .icns skalas av electron-builder ur 1024-bilden). */
const LETTERS_FROM = 64

/**
 * Brickan i bildens koordinater: en pill och bokstäverna D, E, V som streck
 * med runda ändar (samma rundade linjer som ordmärket "booqy").
 */
function badgeShape(tile) {
  const w = BADGE.width * tile.size
  const h = BADGE.height * tile.size
  const inset = BADGE.inset * tile.size
  const x = tile.x + tile.size - inset - w
  const y = tile.y + inset
  const cap = h * 0.54
  const top = y + (h - cap) / 2
  const bottom = top + cap
  const middle = (top + bottom) / 2
  const dW = cap * 0.62
  const eW = cap * 0.56
  const vW = cap * 0.84
  const gapDE = cap * 0.42
  const gapEV = cap * 0.38
  const dX = x + (w - (dW + gapDE + eW + gapEV + vW)) / 2
  const eX = dX + dW + gapDE
  const vX = eX + eW + gapEV
  const bowl = cap / 2
  const flat = dW - bowl
  return {
    box: { x0: x, y0: y, x1: x + w, y1: y + h },
    pill: { ax: x + h / 2, bx: x + w - h / 2, y: y + h / 2, r: h / 2 },
    stroke: (h * 0.14) / 2,
    segments: [
      [dX, top, dX, bottom],
      [dX, top, dX + flat, top],
      [dX, bottom, dX + flat, bottom],
      [eX, top, eX, bottom],
      [eX, top, eX + eW, top],
      [eX, bottom, eX + eW, bottom],
      [eX, middle, eX + eW * 0.86, middle],
      [vX, top, vX + vW / 2, bottom],
      [vX + vW / 2, bottom, vX + vW, top],
    ],
    // D:ets högra halva: en halvcirkel.
    arc: { cx: dX + flat, cy: middle, r: bowl },
  }
}

function inPill(shape, px, py) {
  const { ax, bx, y, r } = shape.pill
  const cx = Math.min(bx, Math.max(ax, px))
  return (px - cx) * (px - cx) + (py - y) * (py - y) <= r * r
}

function inLetters(shape, px, py) {
  const reach = shape.stroke
  for (const [x0, y0, x1, y1] of shape.segments) {
    const dx = x1 - x0
    const dy = y1 - y0
    const t = Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy)))
    const ex = px - (x0 + t * dx)
    const ey = py - (y0 + t * dy)
    if (ex * ex + ey * ey <= reach * reach) return true
  }
  const { cx, cy, r } = shape.arc
  return px >= cx && Math.abs(Math.hypot(px - cx, py - cy) - r) <= reach
}

/**
 * Ritar brickan på bilden. `strict` (full storlek) kräver att hela brickan
 * ligger på rutan: annars har ikonen ändrats så att brickan inte får plats.
 */
function stamp(img, tile, colours, { letters, strict }) {
  const shape = badgeShape(tile)
  const SUB = 4
  const x0 = Math.max(0, Math.floor(shape.box.x0))
  const y0 = Math.max(0, Math.floor(shape.box.y0))
  const x1 = Math.min(img.width - 1, Math.ceil(shape.box.x1))
  const y1 = Math.min(img.height - 1, Math.ceil(shape.box.y1))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let pill = 0
      let ink = 0
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const px = x + (sx + 0.5) / SUB
          const py = y + (sy + 0.5) / SUB
          if (!inPill(shape, px, py)) continue
          pill++
          if (letters && inLetters(shape, px, py)) ink++
        }
      }
      if (pill === 0) continue
      const i = (y * img.width + x) * 4
      const alpha = img.data[i + 3] / 255
      if (strict && alpha !== 1) throw new Error('The DEV badge does not fit inside the icon\'s tile')
      if (alpha === 0) continue
      // Brickan ligger på rutan: den täcker aldrig mer av pixeln än rutan gör.
      const onPill = Math.min(pill / (SUB * SUB), alpha)
      const onInk = Math.min(ink / (SUB * SUB), onPill)
      for (let c = 0; c < 3; c++) {
        const v = img.data[i + c] * (alpha - onPill) + colours.mark[c] * (onPill - onInk) + colours.tile[c] * onInk
        img.data[i + c] = Math.round(v / alpha)
      }
    }
  }
  return img
}

/** Utvecklingsikonen i en viss storlek: produktionsikonen förminskad, med brickan ritad i den storleken. */
function devIcon(base, size = base.width) {
  const tile = tileOf(base)
  const colours = coloursOf(base)
  const k = size / base.width
  const scaled = { x: tile.x * k, y: tile.y * k, size: tile.size * k }
  return stamp(resize(base, size), scaled, colours, { letters: size >= LETTERS_FROM, strict: size === base.width })
}

/** Storlekarna i Linux-uppsättningen (build/icons/16x16.png ...). */
function sizesIn(dir) {
  return fs
    .readdirSync(dir)
    .map((name) => /^(\d+)x\1\.png$/.exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
}

/** Storlekarna i en Windows-ikon. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** En .ico med en PNG per storlek (det format electron-builder själv skriver). */
function encodeIco(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i
    header[at] = size === 256 ? 0 : size
    header[at + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...frames.map((f) => f.png)])
}

/**
 * Ikonerna för ett bygge, som sökvägar från desktop/ (det electron-builder
 * vill ha). Produktion: de incheckade filerna, orörda. Alla andra miljöer:
 * samma ikon med DEV-brickan, skriven till build/dev/ i samma storlekar.
 */
function iconsFor(env, desktopDir = __dirname) {
  if (env === 'prod') return { app: 'build/icon.png', win: 'build/icon.png', set: 'build/icons' }
  const build = path.join(desktopDir, 'build')
  const out = path.join(build, 'dev')
  const base = decodePng(fs.readFileSync(path.join(build, 'icon.png')))
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true })
  for (const size of sizesIn(path.join(build, 'icons'))) {
    fs.writeFileSync(path.join(out, 'icons', `${size}x${size}.png`), encodePng(devIcon(base, size)))
  }
  fs.writeFileSync(path.join(out, 'icon.png'), encodePng(devIcon(base)))
  // Windows: en färdig .ico, så att små storlekar får den rena brickan.
  fs.writeFileSync(path.join(out, 'icon.ico'), encodeIco(ICO_SIZES.map((size) => ({ size, png: encodePng(devIcon(base, size)) }))))
  return { app: 'build/dev/icon.png', win: 'build/dev/icon.ico', set: 'build/dev/icons' }
}

module.exports = { decodePng, encodePng, encodeIco, ICO_SIZES, resize, tileOf, coloursOf, BADGE, badgeShape, stamp, devIcon, iconsFor, LETTERS_FROM }
