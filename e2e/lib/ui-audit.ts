/**
 * Shared UI-test kit (identical copy in admin-front-end/e2e, booqy-console/e2e,
 * customer-front-end/e2e-ui and booqy-website/e2e-ui). Keep the copies in sync.
 *
 * Layout audit runs inside the page and returns a list of issues; the spec
 * turns every issue into a soft assertion and appends it to
 * test-results/ui-issues.jsonl, which summarize-ui.mjs turns into the report.
 */
import { expect, type Page, type TestInfo } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Viewport { name: string; width: number; height: number; kind: 'phone' | 'tablet' | 'desktop' }

export const VIEWPORTS: Viewport[] = [
  { name: '320', width: 320, height: 568, kind: 'phone' },
  { name: '360', width: 360, height: 740, kind: 'phone' },
  { name: '375', width: 375, height: 667, kind: 'phone' },
  { name: '390', width: 390, height: 844, kind: 'phone' },
  { name: '414', width: 414, height: 896, kind: 'phone' },
  { name: '768p', width: 768, height: 1024, kind: 'tablet' },
  { name: '820p', width: 820, height: 1180, kind: 'tablet' },
  { name: '1024l', width: 1024, height: 768, kind: 'tablet' },
  { name: '1180l', width: 1180, height: 820, kind: 'tablet' },
  { name: '1280', width: 1280, height: 720, kind: 'desktop' },
  { name: '1440', width: 1440, height: 900, kind: 'desktop' },
  { name: '1920', width: 1920, height: 1080, kind: 'desktop' },
  { name: '2560', width: 2560, height: 1440, kind: 'desktop' },
]

/** Sizes that also run in WebKit and Firefox: a phone, a tablet and a desktop. */
export const CROSS_BROWSER = ['390', '820p', '1440']
/** Sizes that get visual-regression baselines (keeps the repo small). */
export const VISUAL = (process.env.UI_VISUAL_SIZES ?? '360,1280').split(',')

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export interface Issue { kind: string; severity: Severity; message: string; selector?: string }

const ISSUE_FILE = 'test-results/ui-issues.jsonl'

export function record(info: TestInfo, app: string, page: string, vp: string, theme: string, issues: Issue[], extra: { shot?: string } = {}) {
  mkdirSync(dirname(ISSUE_FILE), { recursive: true })
  const row = { app, page, vp, theme, browser: info.project.name, title: info.title, issues, ...extra }
  appendFileSync(ISSUE_FILE, JSON.stringify(row) + '\n')
}

export interface AuditOpts { phone: boolean; helpSelector?: string; atBottom?: boolean }

/** In-page layout audit at the current scroll position. */
export async function layoutAudit(page: Page, opts: AuditOpts): Promise<Issue[]> {
  return page.evaluate(({ phone, helpSelector, atBottom }) => {
    const issues: { kind: string; severity: string; message: string; selector?: string }[] = []
    const vw = window.innerWidth
    const vh = window.innerHeight
    const seen = new Set<string>()
    function describe(el: Element): string {
      const t = el.tagName.toLowerCase()
      const id = el.id ? '#' + el.id : ''
      const cn = (el as HTMLElement).className
      const cls = typeof cn === 'string' && cn ? '.' + cn.trim().split(/\s+/).slice(0, 2).join('.') : ''
      const label = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40)
      return `${t}${id}${cls}${label ? ` "${label}"` : ''}`
    }
    const add = (kind: string, severity: string, message: string, el?: Element) => {
      const sel = el ? describe(el) : undefined
      const key = kind + '|' + sel + '|' + message
      if (seen.has(key)) return
      seen.add(key)
      issues.push({ kind, severity, message, selector: sel })
    }
    const visible = (el: Element): boolean => {
      const cv = (el as HTMLElement).checkVisibility
      if (cv && !cv.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      if (el.closest('[aria-hidden="true"], [inert]')) return false
      return true
    }
    const scrollerAncestor = (el: Element): boolean => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true
      }
      return false
    }
    const clipRect = (el: Element) => {
      let r = { l: 0, t: 0, r: vw, b: vh }
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
          const pr = p.getBoundingClientRect()
          r = { l: Math.max(r.l, pr.left), t: Math.max(r.t, pr.top), r: Math.min(r.r, pr.right), b: Math.min(r.b, pr.bottom) }
        }
      }
      return r
    }

    // 1. horizontal page scroll
    const doc = document.documentElement
    if (doc.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1) {
      const wide: Element[] = []
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        if (!visible(el)) continue
        const r = el.getBoundingClientRect()
        if (r.right > vw + 1 && !scrollerAncestor(el) && getComputedStyle(el).position !== 'fixed') wide.push(el)
      }
      add('hscroll', 'high', `Page scrolls sideways: content is ${Math.max(doc.scrollWidth, document.body.scrollWidth)}px wide in a ${vw}px window. Widest: ${wide.slice(0, 3).map(describe).join(' | ') || 'n/a'}`, wide[0])
    }

    const interactiveSel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [role=link], [role=option]'
    const interactive = Array.from(document.querySelectorAll(interactiveSel)).filter(visible)

    // 2. cut off at the sides (interactive + text leaves)
    const textLeaves = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,label,th,td,li,span,dt,dd,legend')).filter((e) => {
      if (!visible(e)) return false
      if (e.closest('.sr-only, .visually-hidden, [class*=sr-only]')) return false
      return Array.from(e.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 1)
    })
    for (const el of [...interactive, ...textLeaves]) {
      const r = el.getBoundingClientRect()
      // peeking side cards of a coverflow carousel (data-pos l/r) are meant to run off the edge
      if ((r.left < -1 || r.right > vw + 1) && !scrollerAncestor(el) && !el.closest('[data-pos="l"], [data-pos="r"]')) {
        add('offscreen', 'high', `Cut off at the window edge (left ${Math.round(r.left)}, right ${Math.round(r.right)} of ${vw})`, el)
      }
    }

    // 3. text clipped by its own box
    for (const el of textLeaves) {
      if (el.closest('.sr-only, .visually-hidden, [class*=sr-only]')) continue
      if (el.clientWidth <= 1 || el.clientHeight <= 1) continue
      const s = getComputedStyle(el)
      if (/(hidden|clip)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 2 && s.textOverflow !== 'ellipsis') {
        add('text-clipped', 'medium', `Text is cut off by its box (${el.scrollWidth}px of text in ${el.clientWidth}px)`, el)
      }
      if (/(hidden|clip)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 3 && !/-webkit-box/.test(s.display) && (s as unknown as Record<string, string>).webkitLineClamp !== undefined && ((s as unknown as Record<string, string>).webkitLineClamp === 'none' || (s as unknown as Record<string, string>).webkitLineClamp === '') && s.lineHeight !== 'normal') {
        add('text-clipped', 'medium', `Text is cut off vertically (${el.scrollHeight}px in ${el.clientHeight}px)`, el)
      }
    }

    // 4. interactive element covered by something else
    for (const el of interactive) {
      const r = el.getBoundingClientRect()
      const clip = clipRect(el)
      const l = Math.max(r.left, clip.l, 0), rr = Math.min(r.right, clip.r, vw)
      const t = Math.max(r.top, clip.t, 0), b = Math.min(r.bottom, clip.b, vh)
      if (rr - l < 4 || b - t < 4) continue
      if (getComputedStyle(el).opacity === '0') continue
      const top = document.elementFromPoint((l + rr) / 2, (t + b) / 2)
      if (!top || top === el || el.contains(top) || top.contains(el)) continue
      const lab = (el as HTMLInputElement).labels
      if (lab && Array.from(lab).some((x) => x.contains(top))) continue
      let fixedAnc: Element | null = top
      while (fixedAnc && !/(fixed|sticky)/.test(getComputedStyle(fixedAnc).position)) fixedAnc = fixedAnc.parentElement
      if (fixedAnc) {
        const fr = fixedAnc.getBoundingClientRect()
        // a top bar that content scrolls under is normal
        if (fr.top <= vh * 0.15 && fr.height < vh * 0.3) continue
      }
      const topInDialog = top.closest('[role=dialog], [aria-modal=true], dialog, [class*=backdrop], [class*=overlay], [class*=scrim], [class*=modal]')
      if (topInDialog && !el.closest('[role=dialog], [aria-modal=true], dialog')) continue
      add('covered', fixedAnc ? 'high' : 'medium', `Covered by ${describe(fixedAnc ?? top)}`, el)
    }

    // 5. the floating help button must never touch anything else
    if (helpSelector) {
      const help = document.querySelector(helpSelector)
      if (help && visible(help)) {
        const hr = help.getBoundingClientRect()
        for (const el of [...interactive, ...textLeaves]) {
          if (el === help || help.contains(el) || el.contains(help)) continue
          if (el.closest('.help-panel, [role=dialog]')) continue
          const r = el.getBoundingClientRect()
          const w = Math.min(hr.right, r.right) - Math.max(hr.left, r.left)
          const h = Math.min(hr.bottom, r.bottom) - Math.max(hr.top, r.top)
          // mid-page content may scroll under a floating button; fixed bars and the end of the page may not
          let fixedSelf = false
          for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) if (/(fixed|sticky)/.test(getComputedStyle(p).position)) fixedSelf = true
          if (!atBottom && !fixedSelf) continue
          if (w > 2 && h > 2) add('help-overlap', 'high', 'Overlaps the floating help button', el)
        }
      }
    }

    // 6. fixed bars, toasts, drawers, dialogs must sit inside the window
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const s = getComputedStyle(el)
      const role = el.getAttribute('role')
      const isDialog = role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG'
      if (!(s.position === 'fixed' || isDialog) || !visible(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width >= vw - 1 && r.height >= vh - 1) continue
      if (r.left < -1 || r.right > vw + 1) add('fixed-offscreen', 'high', `Fixed/dialog element leaves the window sideways (left ${Math.round(r.left)}, right ${Math.round(r.right)} of ${vw})`, el)
      if (r.top < -1 || r.bottom > vh + 1) {
        const scrollable = [el, ...Array.from(el.querySelectorAll('*'))].some((c) => {
          const cs = getComputedStyle(c)
          return /(auto|scroll)/.test(cs.overflowY) && c.scrollHeight > c.clientHeight + 1
        })
        let scrollParent = false
        for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) scrollParent = true
        if (!scrollable && !scrollParent) add('fixed-offscreen', 'high', `Fixed/dialog element is taller than the window and cannot scroll (top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)} of ${vh})`, el)
      }
    }

    // 7. tap targets on phones
    if (phone) {
      for (const el of interactive) {
        if (el.matches('input[type=checkbox], input[type=radio]') && (el as HTMLInputElement).labels?.length) continue
        const r = el.getBoundingClientRect()
        if (r.right < 0 || r.left > vw) continue
        if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue
        if (Math.min(r.width, r.height) < 43.5) add('tap-target', 'low', `Tap target ${Math.round(r.width)}x${Math.round(r.height)}px, under 44px`, el)
      }
    }
    return issues
  }, opts) as Promise<Issue[]>
}

/** Audit at the top and at the bottom of the page (fixed bars sit over the end of content). */
export async function fullAudit(page: Page, opts: AuditOpts): Promise<Issue[]> {
  const a = await layoutAudit(page, { ...opts, atBottom: false })
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight)
    for (const el of Array.from(document.querySelectorAll('main, [class*=content], [class*=page]'))) {
      const s = getComputedStyle(el)
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight
    }
  })
  await page.waitForTimeout(150)
  const b = await layoutAudit(page, { ...opts, atBottom: true })
  const seen = new Set(a.map((i) => i.kind + i.selector))
  const fresh = b.filter((i) => !seen.has(i.kind + i.selector))
  // keep the page scrolled to the end when the end is where the problem is, so the failure screenshot shows it
  if (!fresh.some((i) => i.severity !== 'low')) {
    await page.evaluate(() => {
      window.scrollTo(0, 0)
      for (const el of Array.from(document.querySelectorAll('main, [class*=content], [class*=page]'))) el.scrollTop = 0
    })
  }
  return [...a, ...fresh]
}

/** axe: serious and critical only. */
export async function axeIssues(page: Page, exclude: string[] = []): Promise<Issue[]> {
  let builder = new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'] }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
  for (const e of exclude) builder = builder.exclude(e)
  const res = await builder.analyze()
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      kind: 'a11y:' + v.id,
      severity: (v.impact === 'critical' ? 'high' : 'medium') as Severity,
      message: `${v.help} (${v.nodes.length} element${v.nodes.length > 1 ? 's' : ''})`,
      selector: v.nodes[0]?.target?.join(' '),
    }))
}

/** Keyboard focus must be visible on the first few tab stops. */
export async function focusIssues(page: Page, tabs = 6): Promise<Issue[]> {
  const out: Issue[] = []
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (let i = 0; i < tabs; i++) {
    await page.keyboard.press('Tab')
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const rect = el.getBoundingClientRect()
      if (rect.width < 1) return null
      const vis = (e: HTMLElement) => {
        const s = getComputedStyle(e)
        return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'
      }
      let ok = vis(el)
      if (!ok) {
        const wrap = el.closest('label, [class*=field], [class*=input], [class*=select]') as HTMLElement | null
        if (wrap && wrap !== el) ok = vis(wrap)
      }
      const desc = el.tagName.toLowerCase() + ' "' + (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 30) + '"'
      return { ok, desc }
    })
    if (r && !r.ok) out.push({ kind: 'focus-invisible', severity: 'medium', message: 'Keyboard focus is not visible', selector: r.desc })
  }
  return out
}

/**
 * Turn issues into soft assertions. Tap-target findings (low) are recorded in
 * the report but do not fail the run, so a tail of 40px icons does not hide
 * real breakage.
 */
export function assertNoIssues(issues: Issue[]) {
  for (const i of issues) {
    if (i.severity === 'low') continue
    expect.soft(i, `${i.kind}: ${i.message} [${i.selector ?? ''}]`).toBeNull()
  }
}

export async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => { try { localStorage.setItem('booqy-theme', t) } catch { /* ignore */ } }, theme)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
}

/** CSS that makes screenshots stable. */
export const STABLE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}'
