// Builds the help assistant's knowledge base from the console's own code, so
// it never goes stale: every page, menu item, tab, setting, heading, field,
// button, description, KPI and element with data-help is picked up by
// itself, plus the curated guides in src/features/help/helpKb.json.
//
//   node scripts/help-corpus.mjs            # write public/help-corpus.json (npm run dev)
//   node scripts/help-corpus.mjs --stdout   # write to standard out
//
// Builds use helpCorpusPlugin() (vite.config.ts): a hashed file and a meta
// tag in index.html, which the server follows (help_assistant.py _fetch).
// No secrets: only text the console already shows, and anything that looks
// like a key or infrastructure is dropped (SENSITIVE).
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

export const SENSITIVE =
  /AKIA|arn:aws|sk_live|sk_test|pk_live|pk_test|whsec_|\b\d{12}\b|amazonaws|dynamodb|lambda|cognito|tenant_id|password|secret|token/i

/** Same rule as src/features/help/helpId.ts. */
export function helpSlug(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

const TENANT_ROUTE = '/tenants/:tenantId'
// Pages without their own menu item.
const EXTRA_PAGES = {
  [TENANT_ROUTE]: "a customer's page",
  '/outbox': 'Mail',
}
// Slots (src/slots.tsx): where each feature-owned section shows.
const SLOT_PLACES = [
  ['tenant.integrations.', TENANT_ROUTE, 'Integrations'],
  ['tenant.website.', TENANT_ROUTE, 'Website'],
  ['tenant.offboard.', TENANT_ROUTE, 'Suspend or offboard'],
  ['settings.', '/settings', null],
]
// Not part of the signed-in console (or the assistant itself).
const SKIP_DIRS = ['features/help', 'test']

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

const clean = (t) => t.replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/^\+\s*/, '').trim()
const usable = (t) => t.length >= 2 && t.length <= 160 && /[a-z]/i.test(t) && !SENSITIVE.test(t) && !/[=;{}]|=>|\$\{/.test(t)

function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const p of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    try {
      if (statSync(p).isFile() && /\.tsx?$/.test(p)) return p
    } catch {
      /* not there */
    }
  }
  return null
}

const MAIN = () => readFileSync(join(SRC, 'main.tsx'), 'utf8')

/** The menu: NAV groups plus Settings and Download app (ALL_NAV in main.tsx). */
export function parseNav() {
  return [...MAIN().matchAll(/\{ to: "([^"]+)", label: "([^"]+)"/g)].map((m) => ({ to: m[1], label: m[2] }))
}

function parseRoutes() {
  const main = MAIN()
  const modules = Object.fromEntries([...main.matchAll(/(\w+): \(\) => import\("\.\/([^"]+)"\)/g)].map((m) => [m[1], m[2]]))
  const lazyOf = {}
  for (const m of main.matchAll(/const (\w+) = lazy\(pages\.(\w+)\)/g)) lazyOf[m[1]] = modules[m[2]]
  const routes = []
  for (const m of main.matchAll(/<Route path="([^"*]+)" element=\{<(\w+)/g)) routes.push({ path: m[1], comp: m[2] })
  const fileRoute = new Map()
  for (const r of routes) {
    const mod = lazyOf[r.comp]
    const file = mod && resolveImport(join(SRC, 'x.ts'), `./${mod}`)
    if (file && !fileRoute.has(file)) fileRoute.set(file, r.path)
  }
  return { routes: routes.map((r) => r.path), fileRoute }
}

function importsOf(file) {
  const text = readFileSync(file, 'utf8')
  const out = []
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\w\s,{}]*?)\s*from\s+["']([^"']+)["']/g)) {
    if (/^type\b/.test(m[0].slice(7))) continue
    const target = resolveImport(file, m[2])
    if (!target) continue
    const names = m[1].replace(/[{}]/g, ',').split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()).filter(Boolean)
    out.push({ target, names })
  }
  return out
}

/** Tabs of a page: {tab === "X" && <Comp>} and the functions in the file they belong to. */
function sectionsOf(text) {
  const byComp = new Map()
  for (const m of text.matchAll(/\{(?:tab|view) === "([^"]+)" && (?:[\w.()]+ && )*<(\w+)/g)) if (!byComp.has(m[2])) byComp.set(m[2], m[1])
  const fns = [...text.matchAll(/^(?:export )?(?:default )?function (\w+)/gm)].map((m) => ({ name: m[1], at: m.index }))
  const fnAt = (at) => [...fns].reverse().find((f) => f.at <= at)
  // A helper drawn inside a tab's function (a modal, a row) belongs to that tab too.
  for (let round = 0; round < 3; round++) {
    for (const fn of fns) {
      if (byComp.has(fn.name)) continue
      for (const use of text.matchAll(new RegExp(`<${fn.name}\\b`, 'g'))) {
        const owner = fnAt(use.index)
        if (owner && owner.name !== fn.name && byComp.has(owner.name)) {
          byComp.set(fn.name, byComp.get(owner.name))
          break
        }
      }
    }
  }
  const sectionAt = (at) => {
    const fn = fnAt(at)
    return fn ? byComp.get(fn.name) : undefined
  }
  return { byComp, sectionAt }
}

/**
 * Which page (and tab) each file belongs to, through the imports. A file
 * reached from more than one page (shared components) belongs to none.
 */
function placeFiles(fileRoute) {
  const reach = new Map()
  const note = (f, route, section) => {
    const list = reach.get(f) ?? []
    if (!list.some((r) => r.route === route)) list.push({ route, section })
    reach.set(f, list)
  }
  const visit = (start, route, section) => {
    const queue = [start]
    const seen = new Set()
    while (queue.length) {
      const f = queue.shift()
      if (seen.has(f)) continue
      seen.add(f)
      note(f, route, f === start ? section : reach.get(f)?.find((r) => r.route === route)?.section)
      for (const { target } of importsOf(f)) if (!fileRoute.has(target) && !target.endsWith('slots.tsx')) queue.push(target)
    }
  }
  for (const [file, route] of fileRoute) visit(file, route, null)
  const place = new Map()
  for (const [f, list] of reach) if (list.length === 1) place.set(f, { route: list[0].route, section: list[0].section ?? null })
  // A page's tabs: imported components rendered in a tab, or inside a tab's function.
  for (const [file, route] of fileRoute) {
    const text = readFileSync(file, 'utf8')
    const { byComp, sectionAt } = sectionsOf(text)
    if (!byComp.size) continue
    for (const { target, names } of importsOf(file)) {
      const name = names.find((n) => new RegExp(`<${n}\\b`).test(text))
      if (!name || !place.has(target)) continue
      const section = byComp.get(name) ?? sectionAt(text.search(new RegExp(`<${name}\\b`)))
      if (section) {
        place.set(target, { route, section })
        for (const { target: sub } of importsOf(target)) if (place.get(sub)?.route === route) place.set(sub, { route, section })
      }
    }
  }
  // Feature sections in slots (loaded with import(), so not in the graph above).
  const slots = readFileSync(join(SRC, 'slots.tsx'), 'utf8')
  for (const m of slots.matchAll(/"([\w.]+)": \(\) => import\("\.\/([^"]+)"\)/g)) {
    const at = SLOT_PLACES.find(([prefix]) => m[1].startsWith(prefix))
    const file = resolveImport(join(SRC, 'slots.tsx'), `./${m[2]}`)
    if (at && file) place.set(file, { route: at[1], section: at[2] })
  }
  // Settings > Desktop app has its own address (/settings#desktop-app).
  const desktop = join(SRC, 'components/DesktopAppCard.tsx')
  if (place.get(desktop)?.route === '/settings') place.set(desktop, { route: '/settings', section: null, hash: 'desktop-app' })
  return place
}

function extract(text) {
  const out = []
  const add = (kind, value, at, extra = {}) => {
    const t = clean(value)
    if (usable(t)) out.push({ kind, text: t, at, ...extra })
  }
  for (const m of text.matchAll(/<h1[^>]*>\s*([^<>{}]+?)\s*</g)) add('page', m[1], m.index)
  for (const m of text.matchAll(/<h[2-4][^>]*>\s*([^<>{}]+?)\s*<\/h[2-4]>/g)) add('heading', m[1], m.index)
  for (const m of text.matchAll(/<Card\b[^>]*?title="([^"]+)"/g)) add('heading', m[1], m.index, { help: `card:${helpSlug(m[1])}` })
  for (const m of text.matchAll(/className="strong(?: [^"]*)?"[^>]*>\s*([^<>{}]+?)\s*</g)) add('heading', m[1], m.index)
  for (const m of text.matchAll(/<Modal\b[^>]*?title="([^"]+)"/g)) add('heading', m[1], m.index)
  for (const m of text.matchAll(/className="choice[^"]*"[^>]*>\s*(?:<input[^>]*\/>\s*)?<strong>([^<>{}]+?)<\/strong>/g)) add('heading', m[1], m.index)
  for (const m of text.matchAll(/<Field\b[^>]*?label="([^"]+)"/g)) add('field', m[1], m.index)
  for (const m of text.matchAll(/<label\b[^>]*>\s*([^<>{}]+?)\s*</g)) add('field', m[1], m.index)
  for (const m of text.matchAll(/<button\b[^>]*>\s*(?:<Icon[^>]*\/>\s*)?([^<>{}]+?)\s*(?:<Icon[^>]*\/>\s*)?<\/button>/g)) add('button', m[1], m.index)
  for (const m of text.matchAll(/<(?:SaveButton|CtaButton)\b[^>]*?label="([^"]+)"/g)) add('button', m[1], m.index)
  for (const m of text.matchAll(/<(?:Link|a)\b[^>]*className="btn[^"]*"[^>]*>\s*([^<>{}]+?)\s*<\/(?:Link|a)>/g)) add('button', m[1], m.index)
  for (const m of text.matchAll(/<Kpi\b[^>]*?label="([^"]+)"/g)) add('kpi', m[1], m.index, { help: `kpi:${helpSlug(m[1])}` })
  for (const m of text.matchAll(/data-help="([^"]+)"/g)) out.push({ kind: 'anchor', text: '', at: m.index, help: m[1] })
  return out
}

function descriptions(text) {
  const out = []
  for (const m of text.matchAll(/className="(?:[\w-]+ )*muted(?: [\w-]+)*"[^>]*>\s*([^<>{}]+?)\s*</g)) out.push({ at: m.index, text: clean(m[1]) })
  for (const m of text.matchAll(/\b(?:hint|sub)="([^"]+)"/g)) out.push({ at: m.index, text: clean(m[1]) })
  // Conditional text: {condition ? "A" : "B"} right in the paragraph; the first one counts.
  for (const m of text.matchAll(/className="(?:[\w-]+ )*muted(?: [\w-]+)*"[^>]*>\s*\{[^}]*?"([^"]{12,300})"/g)) out.push({ at: m.index, text: clean(m[1]) })
  out.sort((a, b) => a.at - b.at)
  return out.filter((d) => d.text.length >= 8 && d.text.length <= 400 && /[a-z]/i.test(d.text) && !SENSITIVE.test(d.text) && !/=>|\$\{|;|=\{/.test(d.text))
}

/** The tab names of a page: const TABS / VIEWS = ["A", "B"]. */
function tabsOf(text) {
  const m = text.match(/const (?:TABS|VIEWS) = \[([^\]]+)\]/)
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((t) => t[1]) : []
}
// data-help ids of the tab buttons (TenantPage, MailPage, FinancePage).
// Cards with their own address on a page.
const HASH_LABEL = { 'desktop-app': 'Desktop app' }
const TAB_HELP = { [TENANT_ROUTE]: 'tenant-tab', '/mail': 'mail-tab', '/finance': 'finance-tab' }

export function buildCorpus() {
  const files = walk(SRC).filter((f) => !SKIP_DIRS.some((d) => relative(SRC, f).startsWith(d)))
  const nav = parseNav()
  const { routes, fileRoute } = parseRoutes()
  const place = placeFiles(fileRoute)
  const pageLabel = (route) =>
    EXTRA_PAGES[route] ?? nav.find((n) => n.to === route)?.label ?? route
  const where = (route, section, hash) => {
    const page = pageLabel(route)
    if (hash) return `${page}, ${HASH_LABEL[hash] ?? hash}`
    return section ? `${page}, ${section} tab` : page
  }

  const docs = []
  const seen = new Set()
  const push = (doc) => {
    const key = `${doc.route}|${doc.hash ?? ''}|${doc.where ?? ''}|${doc.title.toLowerCase()}|${doc.kind}`
    if (seen.has(key) || seen.has(doc.id)) return
    seen.add(key)
    seen.add(doc.id)
    docs.push({ ...doc, audience: 'all' })
  }

  // The menu.
  for (const item of nav) {
    const [route, hash] = item.to.split('#')
    push({
      id: `nav${item.to === '/' ? ':customers' : item.to.replace(/[/#]/g, ':')}`,
      kind: 'page', route, ...(hash ? { hash } : {}), title: item.label, where: 'the menu',
      text: `${item.label} is in the menu.`,
      highlight: [`help:nav:${item.to}`],
    })
  }
  // The tabs of the customer page, Mail and Finance.
  for (const [file, route] of fileRoute) {
    const prefix = TAB_HELP[route]
    if (!prefix) continue
    for (const tab of tabsOf(readFileSync(file, 'utf8'))) {
      const page = pageLabel(route)
      push({
        id: `${prefix}:${helpSlug(tab)}`, kind: 'page', route, title: tab, where: page,
        text: route === TENANT_ROUTE
          ? `${tab} is a tab on ${page}: open Customers, click the customer and press ${tab}.`
          : `${tab} is a tab on the ${page} page.`,
        highlight: [`help:${prefix}:${helpSlug(tab)}`],
      })
    }
  }

  // Everything the code shows, per file and place.
  for (const file of files.filter((f) => f.endsWith('.tsx'))) {
    const at = place.get(file)
    if (!at) continue
    const text = readFileSync(file, 'utf8')
    const items = extract(text).sort((a, b) => a.at - b.at)
    const descs = descriptions(text)
    const sectionAt = fileRoute.has(file) ? sectionsOf(text).sectionAt : () => undefined
    const rel = relative(SRC, file)
    for (const [i, it] of items.entries()) {
      if (it.kind === 'anchor') continue
      const next = items[i + 1]?.at ?? Infinity
      const desc = descs.find((d) => d.at > it.at && d.at < Math.min(it.at + 700, next + 400))?.text
      const anchor = it.help ?? [...items].reverse().find((a) => a.kind === 'anchor' && a.at < it.at && it.at - a.at < 300)?.help
      const route = at.route
      const section = at.section ?? sectionAt(it.at) ?? null
      const hash = at.hash
      push({
        id: `${rel.replace(/\.tsx$/, '').replace(/[^a-zA-Z0-9]+/g, '-')}:${section ? `${helpSlug(section)}:` : ''}${helpSlug(it.text)}:${it.kind}`,
        kind: it.kind === 'page' ? 'page' : 'element',
        route, ...(hash ? { hash } : {}),
        title: it.text,
        where: where(route, section, hash),
        text: desc ?? '',
        highlight: [anchor ? `help:${anchor}` : `text:${it.text}`],
      })
    }
  }

  // Curated guides (step by step, live numbers).
  const kb = JSON.parse(readFileSync(join(SRC, 'features/help/helpKb.json'), 'utf8'))
  const guides = kb.entries.map((e) => ({ ...e, kind: 'guide' }))
  return { version: 2, app: 'console', routes, docs: [...guides, ...docs] }
}

/**
 * Vite plugin for builds: the corpus as help-corpus.<hash>.json (deploys cache
 * everything but index.html for a year) and a meta tag in index.html naming
 * it, which the server follows. Same as admin-front-end.
 */
export function helpCorpusPlugin() {
  let json = ''
  let file = ''
  return {
    name: 'booqy-help-corpus',
    apply: 'build',
    buildStart() {
      json = `${JSON.stringify(buildCorpus())}\n`
      file = `help-corpus.${createHash('sha256').update(json).digest('hex').slice(0, 10)}.json`
    },
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { name: 'booqy-help-corpus', content: file }, injectTo: 'head' }]
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: file, source: json })
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const corpus = buildCorpus()
  const json = `${JSON.stringify(corpus)}\n`
  if (process.argv.includes('--stdout')) process.stdout.write(json)
  else {
    mkdirSync(join(ROOT, 'public'), { recursive: true })
    writeFileSync(join(ROOT, 'public/help-corpus.json'), json)
    console.log(`help-corpus.json: ${corpus.docs.length} docs`)
  }
}
