// node --test (npm test i desktop/). Offlinesidan och fönstret som glömmer sig självt.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { offlineHtml, forgetOnClose } = require('./shell-core.cjs')
const config = require('./desktop.config.json')

function hexLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [hexLuminance(a), hexLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('offline page text is readable on the light background', () => {
  const html = offlineHtml({ appName: 'Booqy Console', background: config.background, startUrl: 'https://admin.dev.booqy.se/' })
  const body = html.match(/body\{[^}]*background:(#[0-9a-f]{6});color:(#[0-9a-f]{6})/i)
  assert.ok(body, 'body sets background and color')
  assert.equal(body[1], config.background)
  assert.ok(contrast(body[1], body[2]) >= 7, `contrast ${contrast(body[1], body[2]).toFixed(2)} is at least 7:1`)
  const link = html.match(/\ba\{[^}]*background:(#[0-9a-f]{6});color:(#[0-9a-f]{6})/i)
  assert.ok(contrast(link[1], link[2]) >= 4.5, 'the retry link is readable')
})

test('offline page has a readable dark variant', () => {
  const html = offlineHtml({ appName: 'Booqy Console', background: config.background, startUrl: 'https://admin.dev.booqy.se/' })
  const dark = html.match(/prefers-color-scheme:dark\)\{body\{background:(#[0-9a-f]{6});color:(#[0-9a-f]{6})/i)
  assert.ok(dark, 'dark variant present')
  assert.ok(contrast(dark[1], dark[2]) >= 7)
})

test('offline page escapes the app name and address', () => {
  const html = offlineHtml({ appName: 'A<b>"', background: '#ffffff', startUrl: 'https://x.test/?a="><script>' })
  assert.ok(!html.includes('<b>"'))
  assert.ok(!html.includes('"><script>'))
  assert.ok(html.includes('A&lt;b&gt;&quot;'))
})

test('a window reopened from the Dock is forgotten when it closes', () => {
  let current = null
  const get = () => current
  const set = (w) => { current = w }
  const first = forgetOnClose(new EventEmitter(), get, set)
  current = first
  first.emit('closed')
  assert.equal(current, null)
  // macOS: activate opens a new window, which must be cleared too
  const second = forgetOnClose(new EventEmitter(), get, set)
  current = second
  second.emit('closed')
  assert.equal(current, null)
})

test('closing an older window keeps the newer main window', () => {
  let current = null
  const get = () => current
  const set = (w) => { current = w }
  const old = forgetOnClose(new EventEmitter(), get, set)
  const fresh = forgetOnClose(new EventEmitter(), get, set)
  current = fresh
  old.emit('closed')
  assert.equal(current, fresh)
})
