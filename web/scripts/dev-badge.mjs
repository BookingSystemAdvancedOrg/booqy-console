// DEV badge on the web app icons (home screen, installed app, browser tab).
// Same file in admin-front-end and booqy-console/web.
//
// Production builds are left alone: the plugin does nothing, so the icons,
// the manifest and index.html stay exactly as in the repo. A build that is
// positively dev gets badged copies under new file names (*.dev1.*, so no
// cache holds an old plain one) and index.html points at them:
//   pwa/icon-180.dev1.png ... maskable-512.dev1.png   the PWA icons
//   app.dev1.webmanifest                              "... Dev" names
//   favicon-dev.v1.svg, favicon-dev-dark.v1.svg       browser tab
// The badge is drawn by desktop/dev-icon.cjs, the same code and look as the
// desktop app's dev icon: the icon's own two colours swapped, top right.
//
// Bump "dev1" (and the favicon "v1") when the badge or the icons change: the
// deploy caches everything but index.html for a year.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const DEV_TAG = 'dev1'
const PNG_ICONS = ['icon-180', 'icon-192', 'icon-512', 'maskable-512']
/** Badge size on a maskable icon, as if the tile were this part of the side (the full badge would be cropped away). */
const MASKABLE_TILE = 0.6
/** Maskable icons keep only a centred circle of this radius (part of the side): the safe zone. */
const MASKABLE_SAFE = 0.4

/** The virtual tile for a maskable icon: badge as large as MASKABLE_TILE gives, its round right end touching the safe circle. */
export function maskableTile(side, BADGE) {
  const size = side * MASKABLE_TILE
  const r = (BADGE.height * size) / 2
  const endX = size * (1 - BADGE.inset) - r
  const endY = size * BADGE.inset + r
  const d = (side * MASKABLE_SAFE - r) / Math.SQRT2
  return { x: side / 2 + d - endX, y: side / 2 - d - endY, size }
}
const FAVICON_LIGHT = 'favicon-dev.v1.svg'
const FAVICON_DARK = 'favicon-dev-dark.v1.svg'

/**
 * Is this build dev? Only a positive yes counts: prod, unknown and missing
 * values all give false, so a prod build can never get the badge by accident.
 *  - vite dev server (command "serve"): yes; vitest (mode "test"): no
 *  - VITE_ENVIRONMENT "dev" (booqy-console deploy): yes, "prod": no
 *  - VITE_API_BASE_URL equal to the dev API (admin-front-end deploy): yes
 */
export function isDevBuild({ command, mode, environment, apiBaseUrl, devApiBaseUrl }) {
  if (mode === 'test') return false
  const env = (environment ?? '').trim().toLowerCase()
  if (env === 'prod') return false
  if (command === 'serve') return true
  if (env === 'dev') return true
  const norm = (u) => (u ?? '').trim().replace(/\/+$/, '')
  return norm(devApiBaseUrl) !== '' && norm(apiBaseUrl) === norm(devApiBaseUrl)
}

/** VITE_API_BASE_URL_DEV from .github/config/project.env (read only), or undefined. */
export function readDevApiBaseUrl(repoRoot) {
  try {
    const text = fs.readFileSync(path.join(repoRoot, '.github', 'config', 'project.env'), 'utf8')
    const m = /^VITE_API_BASE_URL_DEV=["']?([^"'\s#]+)/m.exec(text)
    return m ? m[1] : undefined
  } catch {
    return undefined
  }
}

/** The DEV pill as SVG for a favicon: same letters as the PNG badge, sized to read in a browser tab. */
export function faviconBadgeSvg(svg, letterColour, { BADGE, badgeShape }) {
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg)
  const ink = /(?:stroke|fill)="(#[0-9a-fA-F]{3,8})"/.exec(svg)
  if (!vb || !ink) throw new Error('Favicon needs a viewBox and a colour')
  const [vx, vy, vw] = vb.slice(1, 4).map(Number)
  const h = vw * 0.31
  const w = h * 2
  const box = { x0: vx + vw - w, y0: vy, x1: vx + vw, y1: vy + h }
  // badgeShape for a 1-unit tile, scaled so its pill height is h and its letters centred in our box.
  const s = badgeShape({ x: 0, y: 0, size: 1 })
  const k = h / BADGE.height
  const cx = (s.box.x0 + s.box.x1) / 2
  const cy = (s.box.y0 + s.box.y1) / 2
  const X = (x) => +((x - cx) * k + (box.x0 + box.x1) / 2).toFixed(2)
  const Y = (y) => +((y - cy) * k + (box.y0 + box.y1) / 2).toFixed(2)
  const lines = s.segments.map(([a, b, c, d]) => `M${X(a)} ${Y(b)}L${X(c)} ${Y(d)}`).join('')
  const r = +(s.arc.r * k).toFixed(2)
  const arc = `M${X(s.arc.cx)} ${Y(s.arc.cy - s.arc.r)}A${r} ${r} 0 0 1 ${X(s.arc.cx)} ${Y(s.arc.cy + s.arc.r)}`
  const badge =
    `<rect x="${+box.x0.toFixed(2)}" y="${+box.y0.toFixed(2)}" width="${+w.toFixed(2)}" height="${+h.toFixed(2)}" rx="${+(h / 2).toFixed(2)}" fill="${ink[1]}"/>` +
    `<path d="${lines}${arc}" fill="none" stroke="${letterColour}" stroke-width="${+(h * 0.17).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`
  return svg.replace(/<\/svg>\s*$/, `${badge}</svg>\n`)
}

/**
 * Builds every dev file: { "pwa/icon-180.dev1.png": Buffer, ... }.
 * publicDir holds app.v1.webmanifest and pwa/, assetsDir favicon(-dark).svg,
 * devIconPath desktop/dev-icon.cjs.
 */
export function buildDevFiles({ publicDir, assetsDir, devIconPath }) {
  const badge = require(devIconPath)
  const { decodePng, encodePng, devIcon, coloursOf, stamp } = badge
  const files = {}
  for (const name of PNG_ICONS) {
    const base = decodePng(fs.readFileSync(path.join(publicDir, 'pwa', `${name}.v1.png`)))
    let img
    if (name.startsWith('maskable')) {
      img = stamp({ ...base, data: new Uint8Array(base.data) }, maskableTile(base.width, badge.BADGE), coloursOf(base), { letters: true, strict: true })
    } else img = devIcon(base)
    files[`pwa/${name}.${DEV_TAG}.png`] = encodePng(img)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'app.v1.webmanifest'), 'utf8'))
  manifest.name = `${manifest.name} Dev`
  manifest.short_name = manifest.name
  manifest.icons = manifest.icons.map((i) => ({ ...i, src: i.src.replace(/\.v1\.png$/, `.${DEV_TAG}.png`) }))
  files[`app.${DEV_TAG}.webmanifest`] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  const light = fs.readFileSync(path.join(assetsDir, 'favicon.svg'), 'utf8')
  const dark = fs.readFileSync(path.join(assetsDir, 'favicon-dark.svg'), 'utf8')
  const colourOf = (svg) => /(?:stroke|fill)="(#[0-9a-fA-F]{3,8})"/.exec(svg)[1]
  files[FAVICON_LIGHT] = Buffer.from(faviconBadgeSvg(light, colourOf(dark), badge))
  files[FAVICON_DARK] = Buffer.from(faviconBadgeSvg(dark, colourOf(light), badge))
  return files
}

/** index.html for a dev build: badged icons, dev manifest, "... Dev" home screen title. */
export function devIndexHtml(html) {
  const out = html
    .replace('href="/app.v1.webmanifest"', `href="/app.${DEV_TAG}.webmanifest"`)
    .replace('href="/pwa/icon-180.v1.png"', `href="/pwa/icon-180.${DEV_TAG}.png"`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")([^"]*)(")/, '$1$2 Dev$3')
    .replace(/<link rel="icon"[^>]*media="\(prefers-color-scheme: light\)"[^>]*>/, `<link rel="icon" type="image/svg+xml" href="/${FAVICON_LIGHT}" media="(prefers-color-scheme: light)" />`)
    .replace(/<link rel="icon"[^>]*media="\(prefers-color-scheme: dark\)"[^>]*>/, `<link rel="icon" type="image/svg+xml" href="/${FAVICON_DARK}" media="(prefers-color-scheme: dark)" />`)
  for (const want of [`/app.${DEV_TAG}.webmanifest`, `/pwa/icon-180.${DEV_TAG}.png`, `/${FAVICON_LIGHT}`, `/${FAVICON_DARK}`, ' Dev"']) {
    if (!out.includes(want)) throw new Error(`dev badge: index.html no longer has the icon link for ${want}`)
  }
  return out
}

const TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }

/**
 * Vite plugin. `decide(command, mode)` says whether this build is dev (see
 * isDevBuild); when it is not, the plugin does nothing at all. root: the
 * Vite root (public/, src/assets/); devIconPath: desktop/dev-icon.cjs.
 */
export function devBadgePlugin({ root, devIconPath, decide }) {
  let dev = false
  let files
  const get = () =>
    (files ??= buildDevFiles({
      publicDir: path.join(root, 'public'),
      assetsDir: path.join(root, 'src', 'assets'),
      devIconPath,
    }))
  return {
    name: 'booqy-dev-badge',
    config(_c, { command, mode }) {
      dev = decide(command, mode)
    },
    configResolved(c) {
      if (dev) c.logger.info('DEV badge: dev build, app icons get the DEV badge')
    },
    transformIndexHtml: {
      order: 'post',
      handler: (html) => (dev ? devIndexHtml(html) : html),
    },
    generateBundle() {
      if (!dev) return
      for (const [fileName, source] of Object.entries(get())) this.emitFile({ type: 'asset', fileName, source })
    },
    configureServer(server) {
      if (!dev) return
      server.middlewares.use((req, res, next) => {
        const file = get()[(req.url ?? '').split('?')[0].replace(/^\//, '')]
        if (!file) return next()
        res.setHeader('Content-Type', TYPES[path.extname(req.url.split('?')[0])] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(file)
      })
    },
  }
}
