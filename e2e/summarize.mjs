// Prints one line per test from test-results/results.json: status, title, first error line.
import { readFileSync } from 'node:fs'
const r = JSON.parse(readFileSync(process.argv[2] ?? 'test-results/results.json', 'utf8'))
const walk = (s, path = []) => {
  for (const c of s.suites ?? []) walk(c, [...path, c.title])
  for (const sp of s.specs ?? []) for (const t of sp.tests) {
    const res = t.results.at(-1) ?? {}
    const err = (res.error?.message ?? '').replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '').split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 300)
    const ann = (t.annotations ?? []).map((a) => `[${a.type}: ${a.description}]`).join(' ')
    const att = (res.attachments ?? []).filter((a) => a.body && /errors|requests/.test(a.name)).map((a) => `{${a.name}: ${Buffer.from(a.body, 'base64').toString().split('\n').slice(0, 4).join(' ; ')}}`).join(' ')
    console.log(`${res.status === 'passed' ? 'PASS' : res.status?.toUpperCase()} | ${t.projectName} | ${[...path.slice(1), sp.title].join(' > ')} | ${err} ${ann} ${att}`)
  }
}
walk(r)
