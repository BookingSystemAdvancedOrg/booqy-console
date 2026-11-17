// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error CommonJS helper without types, shared with the desktop build
import devIconModule from '../../desktop/dev-icon.cjs'
import { buildDevFiles, devBadgePlugin, devIndexHtml, isDevBuild, maskableTile, readDevApiBaseUrl } from '../scripts/dev-badge.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const devIconPath = `${root}../desktop/dev-icon.cjs`
const devIcon = devIconModule as {
  decodePng: (b: Uint8Array) => { width: number; data: Uint8Array }
  BADGE: { inset: number; width: number; height: number }
}
const DEV_API = 'https://dev.example.test'

// The DEV badge is drawn only when the build is positively dev; prod and unknown stay plain.
describe('isDevBuild', () => {
  it('dev builds', () => {
    expect(isDevBuild({ command: 'serve', mode: 'development' })).toBe(true)
    expect(isDevBuild({ command: 'build', environment: 'dev' })).toBe(true)
    expect(isDevBuild({ command: 'build', apiBaseUrl: DEV_API, devApiBaseUrl: DEV_API })).toBe(true)
    expect(isDevBuild({ command: 'build', apiBaseUrl: `${DEV_API}/`, devApiBaseUrl: DEV_API })).toBe(true)
  })
  it('prod and unknown builds stay plain', () => {
    expect(isDevBuild({ command: 'build' })).toBe(false)
    expect(isDevBuild({ command: 'build', environment: 'prod' })).toBe(false)
    expect(isDevBuild({ command: 'build', environment: 'prod', apiBaseUrl: DEV_API, devApiBaseUrl: DEV_API })).toBe(false)
    expect(isDevBuild({ command: 'build', apiBaseUrl: 'https://prod.example.test', devApiBaseUrl: DEV_API })).toBe(false)
    expect(isDevBuild({ command: 'build', apiBaseUrl: '', devApiBaseUrl: '' })).toBe(false)
    expect(isDevBuild({ command: 'build', apiBaseUrl: DEV_API })).toBe(false)
    expect(isDevBuild({ command: 'build', environment: 'staging' })).toBe(false)
    expect(isDevBuild({ command: 'serve', mode: 'test' })).toBe(false)
  })
  it('without project.env there is no dev API to match', () => {
    expect(readDevApiBaseUrl('/nowhere')).toBeUndefined()
  })
})

describe('dev icons', () => {
  const html = readFileSync(`${root}index.html`, 'utf8')

  it('prod build leaves index.html untouched', () => {
    const plugin = devBadgePlugin({ root, devIconPath, decide: () => false })
    ;(plugin.config as (c: object, e: object) => void)({}, { command: 'build', mode: 'production' })
    const t = plugin.transformIndexHtml as { handler: (h: string) => string }
    expect(t.handler(html)).toBe(html)
  })

  it('dev index.html points at the badged files', () => {
    const out = devIndexHtml(html)
    expect(out).toContain('href="/pwa/icon-180.dev1.png"')
    expect(out).toContain('href="/app.dev1.webmanifest"')
    expect(out).toContain('href="/favicon-dev.v1.svg"')
    expect(out).toContain('href="/favicon-dev-dark.v1.svg"')
    expect(out).toMatch(/apple-mobile-web-app-title" content="[^"]+ Dev"/)
    expect(out).not.toContain('.v1.png')
  })

  it('badged files differ from the plain ones and keep their size', () => {
    const files = buildDevFiles({ publicDir: `${root}public`, assetsDir: `${root}src/assets`, devIconPath })
    const manifest = JSON.parse(new TextDecoder().decode(files['app.dev1.webmanifest']))
    expect(manifest.name).toMatch(/ Dev$/)
    expect(manifest.short_name).toBe(manifest.name)
    for (const icon of manifest.icons) {
      const name = icon.src.slice(1)
      const plain = readFileSync(`${root}public/${name.replace('.dev1.', '.v1.')}`)
      const badged = devIcon.decodePng(files[name])
      expect(badged.width).toBe(Number(icon.sizes.split('x')[0]))
      expect(Buffer.from(badged.data).equals(Buffer.from(devIcon.decodePng(plain).data))).toBe(false)
    }
    for (const f of ['favicon-dev.v1.svg', 'favicon-dev-dark.v1.svg']) {
      expect(new TextDecoder().decode(files[f])).toMatch(/<rect [^>]*rx=.*<\/svg>/)
    }
  })

  it('maskable badge stays inside the safe circle', () => {
    const side = 512
    const t = maskableTile(side, devIcon.BADGE)
    const r = (devIcon.BADGE.height * t.size) / 2
    const right = { x: t.x + t.size * (1 - devIcon.BADGE.inset) - r, y: t.y + t.size * devIcon.BADGE.inset + r }
    expect(Math.hypot(right.x - side / 2, right.y - side / 2) + r).toBeLessThanOrEqual(side * 0.4 + 0.01)
  })
})
