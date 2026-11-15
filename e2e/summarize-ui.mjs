// Summarises test-results/ui-issues.jsonl into JSON (--json) or Markdown.
// Usage: node summarize-ui.mjs [--json out.json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const file = 'test-results/ui-issues.jsonl'
if (!existsSync(file)) { console.error('No results yet: run npm run test:ui first'); process.exit(1) }
const rows = new Map()
for (const l of readFileSync(file, 'utf8').trim().split('\n')) {
  const r = JSON.parse(l)
  rows.set(`${r.browser}|${r.app}|${r.page}|${r.vp}|${r.theme}`, r) // last run wins
}
const all = [...rows.values()]
const SEV = ['critical', 'high', 'medium', 'low']
const norm = (m) => m.replace(/\d+(\.\d+)?/g, 'N').slice(0, 110)
const findings = new Map()
for (const r of all) {
  for (const i of r.issues) {
    const key = `${i.kind}|${i.severity}|${norm(i.message)}|${(i.selector ?? '').replace(/\d+/g, 'N').slice(0, 70)}`
    const f = findings.get(key) ?? { kind: i.kind, severity: i.severity, message: i.message, selector: i.selector ?? '', pages: new Set(), vps: new Set(), browsers: new Set(), themes: new Set(), count: 0, example: r }
    f.pages.add(r.page); f.vps.add(r.vp); f.browsers.add(r.browser); f.themes.add(r.theme); f.count++
    findings.set(key, f)
  }
}
const list = [...findings.values()].sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || b.count - a.count)
const pages = [...new Set(all.map((r) => r.page))]
const vps = [...new Set(all.map((r) => r.vp))]
const matrix = pages.map((p) => ({
  page: p,
  cells: vps.map((v) => {
    const rs = all.filter((r) => r.page === p && r.vp === v && r.browser === 'chromium')
    if (!rs.length) return null
    return { light: rs.find((r) => r.theme === 'light')?.issues.filter((i) => i.severity !== 'low').length ?? null, dark: rs.find((r) => r.theme === 'dark')?.issues.filter((i) => i.severity !== 'low').length ?? null }
  }),
}))
const out = { tests: all.length, withIssues: all.filter((r) => r.issues.some((i) => i.severity !== 'low')).length, bySeverity: Object.fromEntries(SEV.map((s) => [s, list.filter((f) => f.severity === s).length])), findings: list.map((f) => ({ ...f, pages: [...f.pages], vps: [...f.vps], browsers: [...f.browsers], themes: [...f.themes], example: { page: f.example.page, vp: f.example.vp, theme: f.example.theme, browser: f.example.browser } })), pages, vps, matrix }
const j = process.argv.indexOf('--json')
if (j > 0) writeFileSync(process.argv[j + 1], JSON.stringify(out, null, 1))
else {
  console.log(`${out.tests} test runs, ${out.withIssues} with findings (excluding tap-size notes)`)
  for (const f of out.findings.filter((f) => f.severity !== 'low').slice(0, 40)) console.log(`${f.severity.padEnd(8)} ${f.kind.padEnd(22)} x${f.count} pages:${f.pages.length} ${f.message.slice(0, 90)} [${f.selector.slice(0, 50)}]`)
}
