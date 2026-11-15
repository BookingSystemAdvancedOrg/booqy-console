#!/usr/bin/env node
// Copies the corpus built from the code and the eval questions to the server,
// as the fallback when the console's deployed corpus can't be fetched, and
// for the server's tests:
//   (built)                              -> ../../application/shared/help_corpus_console.json
//   src/features/help/helpKbCases.json   -> ../../application/shared/help_cases_console.json
//
//   node scripts/sync-help-kb.mjs           # write
//   node scripts/sync-help-kb.mjs --check   # write nothing, exit 1 if they differ
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCorpus } from './help-corpus.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = resolve(root, '../../application/shared')
if (!existsSync(app)) {
  console.error(`can't find ${app}`)
  process.exit(1)
}
const files = [
  ['help_corpus_console.json', buildCorpus()],
  ['help_cases_console.json', JSON.parse(readFileSync(resolve(root, 'src/features/help/helpKbCases.json'), 'utf8'))],
]
const check = process.argv.includes('--check')
let diff = false
for (const [name, value] of files) {
  const text = `${JSON.stringify(value, null, 1)}\n`
  const target = resolve(app, name)
  if ((existsSync(target) ? readFileSync(target, 'utf8') : '') === text) continue
  diff = true
  if (check) console.error(`${name} differs; run npm run help-kb:sync`)
  else writeFileSync(target, text)
}
process.exit(check && diff ? 1 : 0)
