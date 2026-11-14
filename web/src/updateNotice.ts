/**
 * "Ny version finns": visar en glasruta med knappen Ladda om när en ny
 * version är deployad. Laddar aldrig om av sig själv, så inget osparat går
 * förlorat.
 *
 * Hur en ny version upptäcks: deployen skriver index.html med no-cache och
 * gör en CloudFront-invalidering, medan allt annat cachas i ett år. Därför
 * jämförs index.html:s ETag (innehållets MD5 från S3), inte en version.json
 * som skulle fastna i cachen. Kontroll var 60:e sekund medan fliken syns och
 * direkt när fönstret får fokus igen.
 *
 * Omladdningen fastnar aldrig: osparade ändringar frågas om i rutan (inte
 * via beforeunload, som skrivbordsappen annars kan avbryta tyst), hämtningen
 * av färska filer ges högst 3 s, och lever sidan kvar 8 s efter reload()
 * kommer knappen tillbaka med en kort förklaring. Under tiden rusar en
 * förloppsfyllning till 80 %, kryper mot 95 % och slår i 100 % precis före
 * bytet; den nya sidan visar "Uppdaterad" en kort stund.
 *
 * Samma fil finns i admin och konsolen (gästsajten och booqy.se har en
 * äldre kopia). Ändra dem tillsammans.
 */

import { UPDATED_FLAG_KEY } from './storageRegistry'

const CHECK_EVERY_MS = 60_000
const STYLE_ID = 'booqy-update-style'
/** Längsta väntan på att färska filer hämtats innan omladdningen ändå sker. */
export const FETCH_TIMEOUT_MS = 3_000
/** Lever sidan kvar så här länge efter reload() har något stoppat bytet. */
export const FAILSAFE_MS = 8_000
/** Snabbfasen: 0 till 80 % på den här tiden. */
export const RUSH_MS = 600
/** Från 100 % (med glöd) till själva omladdningen. */
const FINISH_MS = 420
const UPDATED_KEY = UPDATED_FLAG_KEY
const UPDATED_MS = 1_500

const CSS = `
.booqy-update{position:fixed;z-index:2147483000;left:50%;bottom:max(16px,env(safe-area-inset-bottom));
transform:translateX(-50%);display:flex;align-items:center;gap:12px;overflow:hidden;isolation:isolate;
width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 10px 10px 18px;
border-radius:16px;border:1px solid var(--glass-edge,rgba(253,250,246,.55));
background:var(--glass-pop,rgba(251,250,246,.74));color:var(--ink,#1c1918);
-webkit-backdrop-filter:blur(20px) saturate(1.5);backdrop-filter:blur(20px) saturate(1.5);
box-shadow:0 14px 34px -12px rgba(28,25,24,.45),inset 0 1px 0 rgba(253,250,246,.6);
font:600 0.95rem/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;animation:booqy-update-in .42s cubic-bezier(.16,1,.3,1)}
.booqy-update__text{flex:1 1 auto;position:relative}
.booqy-update__note{display:block;font-weight:500;font-size:.82rem;opacity:.75}
.booqy-update__btn{appearance:none;border:0;border-radius:999px;padding:9px 16px;cursor:pointer;
background:#1c1918;color:#fbfaf6;font:inherit;font-weight:700;white-space:nowrap;position:relative}
.booqy-update__btn:hover{background:#350001}
.booqy-update__btn--ghost{background:transparent;color:inherit;box-shadow:inset 0 0 0 1px currentColor}
.booqy-update__btn--ghost:hover{background:rgba(28,25,24,.08)}
.booqy-update__btn:focus-visible,.booqy-update__close:focus-visible{outline:2px solid #9e1d26;outline-offset:2px}
.booqy-update__close{appearance:none;border:0;background:transparent;color:inherit;opacity:.7;cursor:pointer;
width:32px;height:32px;border-radius:999px;font:inherit;font-size:1.15rem;line-height:1;position:relative}
.booqy-update__close:hover{opacity:1}
.booqy-update__fill{position:absolute;inset:0;z-index:-1;transform-origin:0 50%;transform:scaleX(0);
background:linear-gradient(90deg,rgba(158,29,38,.06),rgba(158,29,38,.2) 70%,rgba(158,29,38,.34));will-change:transform}
.booqy-update__glow{position:absolute;inset:0;z-index:-1;border-radius:inherit;opacity:0;pointer-events:none;
background:radial-gradient(120% 160% at 100% 50%,rgba(158,29,38,.38),transparent 60%);transition:opacity .3s ease-out}
.booqy-update__pct{font-variant-numeric:tabular-nums;font-weight:700;min-width:3.4em;text-align:right;padding-right:8px;position:relative}
.booqy-update.is-loading{padding-right:12px}
.booqy-update.is-done .booqy-update__glow{opacity:1}
.booqy-update.is-done{animation:booqy-update-pop .42s cubic-bezier(.16,1,.3,1)}
.booqy-curtain{position:fixed;inset:0;z-index:2147482999;pointer-events:none;opacity:0;
background:rgba(246,241,234,.38);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);transition:opacity .38s ease-out}
.booqy-curtain.is-on{opacity:1}
.booqy-updated{position:fixed;z-index:2147483000;left:50%;bottom:max(16px,env(safe-area-inset-bottom));
transform:translateX(-50%);display:flex;align-items:center;gap:10px;box-sizing:border-box;padding:10px 18px 10px 12px;
border-radius:999px;border:1px solid var(--glass-edge,rgba(253,250,246,.55));
background:var(--glass-pop,rgba(251,250,246,.74));color:var(--ink,#1c1918);pointer-events:none;
-webkit-backdrop-filter:blur(20px) saturate(1.5);backdrop-filter:blur(20px) saturate(1.5);
box-shadow:0 14px 34px -12px rgba(28,25,24,.45),inset 0 1px 0 rgba(253,250,246,.6);
font:700 0.95rem/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;
animation:booqy-update-in .42s cubic-bezier(.16,1,.3,1),booqy-updated-out .4s ease-in 1.1s forwards}
.booqy-updated__badge{position:relative;width:26px;height:26px;border-radius:999px;background:#350001;flex:none;
animation:booqy-updated-badge .5s cubic-bezier(.34,1.56,.64,1)}
.booqy-updated__leg{position:absolute;height:2.6px;border-radius:2px;background:#fbfaf6;transform-origin:0 50%;transform:scaleX(0)}
.booqy-updated__leg--a{left:7px;top:13.5px;width:5px;transform:rotate(45deg) scaleX(0);animation:booqy-tick-a .16s ease-out .18s forwards}
.booqy-updated__leg--b{left:9.6px;top:16.6px;width:10.5px;transform:rotate(-50deg) scaleX(0);animation:booqy-tick-b .22s ease-out .33s forwards}
.booqy-updated__spark{position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px;border-radius:999px;opacity:0;
animation:booqy-spark .7s cubic-bezier(.16,1,.3,1) .22s forwards}
[data-theme="dark"] .booqy-update,[data-theme="dark"] .booqy-updated{background:var(--glass-pop,rgba(31,22,18,.78));color:#f6ece9;
border-color:var(--glass-edge,rgba(246,236,233,.16));box-shadow:0 14px 34px -12px rgba(0,0,0,.7),inset 0 1px 0 rgba(246,236,233,.08)}
[data-theme="dark"] .booqy-update__btn{background:#fbfaf6;color:#1c1918}
[data-theme="dark"] .booqy-update__btn:hover{background:#f6ece9}
[data-theme="dark"] .booqy-update__btn--ghost{background:transparent;color:inherit}
[data-theme="dark"] .booqy-update__btn--ghost:hover{background:rgba(246,236,233,.1)}
[data-theme="dark"] .booqy-update__fill{background:linear-gradient(90deg,rgba(158,29,38,.18),rgba(158,29,38,.45) 70%,rgba(196,60,66,.62))}
[data-theme="dark"] .booqy-update__glow{background:radial-gradient(120% 160% at 100% 50%,rgba(214,92,96,.5),transparent 60%)}
[data-theme="dark"] .booqy-curtain{background:rgba(20,14,12,.42)}
[data-theme="dark"] .booqy-updated__badge{background:#f6ece9}
[data-theme="dark"] .booqy-updated__leg{background:#350001}
@media (prefers-reduced-motion:reduce){.booqy-update,.booqy-update.is-done,.booqy-updated,.booqy-updated__badge{animation:none}
.booqy-updated{animation:booqy-updated-out .01s linear 1.4s forwards}
.booqy-updated__leg--a{animation:none;transform:rotate(45deg)}.booqy-updated__leg--b{animation:none;transform:rotate(-50deg)}
.booqy-updated__spark{display:none}.booqy-curtain,.booqy-update__glow{transition:none}}
@keyframes booqy-update-in{from{opacity:0;transform:translate(-50%,12px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes booqy-update-pop{40%{transform:translateX(-50%) scale(1.04)}to{transform:translateX(-50%) scale(1)}}
@keyframes booqy-updated-out{to{opacity:0;transform:translate(-50%,8px)}}
@keyframes booqy-updated-badge{from{transform:scale(.4)}to{transform:scale(1)}}
@keyframes booqy-tick-a{to{transform:rotate(45deg) scaleX(1)}}
@keyframes booqy-tick-b{to{transform:rotate(-50deg) scaleX(1)}}
@keyframes booqy-spark{0%{opacity:1;transform:rotate(var(--a)) translateX(4px) scale(1)}100%{opacity:0;transform:rotate(var(--a)) translateX(24px) scale(.4)}}
`

export type UpdateNoticeLabels = {
  text: string
  reload: string
  reloading: string
  later: string
  hint: string
  unsaved: string
  reloadAnyway: string
  cancel: string
  failed: string
  updated: string
}

/** Svenska som standard; konsolen (engelskt gränssnitt) skickar egna. */
const SV: UpdateNoticeLabels = {
  text: 'Ny version finns',
  reload: 'Ladda om',
  reloading: 'Laddar om',
  later: 'Inte nu',
  hint: 'Hämtar den nya versionen. Spara först det du håller på med.',
  unsaved: 'Du har osparade ändringar',
  reloadAnyway: 'Ladda om ändå',
  cancel: 'Avbryt',
  failed: 'Kunde inte ladda om. Försök igen.',
  updated: 'Uppdaterad',
}

export type UpdateNoticeOptions = {
  /** Filen (eller filerna) vars ETag jämförs. booqy.se skickar sidan, css och js. */
  url?: string | string[]
  intervalMs?: number
  labels?: Partial<UpdateNoticeLabels>
  /** Finns det osparade ändringar? Då frågar rutan innan den laddar om. */
  hasUnsaved?: () => boolean
  /** Släpper sidans lämna-spärr (beforeunload) inför omladdningen. */
  discardUnsaved?: () => void
}

/** Själva omladdningen, utbytbar i tester (jsdom kan inte ladda om). */
export const page = { reload: () => location.reload() }

/** Läser versionen (ETag, annars Last-Modified) förbi alla cacher. */
export async function readVersion(url: string | string[]): Promise<string | null> {
  const urls = Array.isArray(url) ? url : [url]
  const parts = await Promise.all(
    urls.map(async (u) => {
      const res = await fetch(u, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
      if (!res.ok) return null
      return res.headers.get('etag') ?? res.headers.get('last-modified')
    }),
  )
  return parts.some((p) => p === null) ? null : parts.join('|')
}

/**
 * Hämtar om sidans egna skript och stilmallar förbi webbläsarens cache, högst
 * FETCH_TIMEOUT_MS. Filer med hash i namnet byts ändå, men utan hash (som på
 * booqy.se) kunde en vanlig omladdning annars visa gammal kod en stund.
 */
export async function refreshOwnFiles(timeoutMs = FETCH_TIMEOUT_MS): Promise<void> {
  const urls = new Set<string>()
  document.querySelectorAll<HTMLScriptElement>('script[src]').forEach((s) => urls.add(s.src))
  document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]').forEach((l) => urls.add(l.href))
  const own = [...urls].filter((u) => {
    try {
      return new URL(u).origin === location.origin
    } catch {
      return false
    }
  })
  if (own.length === 0) return
  const abort = new AbortController()
  let timer = 0
  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(() => {
      abort.abort()
      resolve()
    }, timeoutMs)
  })
  const all = Promise.allSettled(
    own.map((u) => fetch(u, { cache: 'reload', credentials: 'same-origin', signal: abort.signal })),
  ).then(() => undefined)
  await Promise.race([all, timeout])
  window.clearTimeout(timer)
}

/** Hämtar färska filer (högst 3 s) och laddar sedan om. */
export async function reloadFresh(): Promise<void> {
  await refreshOwnFiles()
  page.reload()
}

/**
 * Förloppet (0 till 1) efter `ms` millisekunder: 80 % på RUSH_MS med mjuk
 * inbromsning, sedan allt långsammare mot 95 %. 100 % nås bara när filerna
 * verkligen är klara (finish i rutan).
 */
export function reloadProgress(ms: number): number {
  if (ms <= 0) return 0
  if (ms < RUSH_MS) {
    const t = ms / RUSH_MS
    return 0.8 * (1 - (1 - t) ** 3)
  }
  return Math.min(0.95, 0.8 + 0.15 * (1 - Math.exp(-(ms - RUSH_MS) / 2_500)))
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

type NoticeDeps = Pick<UpdateNoticeOptions, 'hasUnsaved' | 'discardUnsaved'>

function showNotice(labels: UpdateNoticeLabels, deps: NoticeDeps, onDismiss: () => void): void {
  if (document.querySelector('.booqy-update')) return
  injectStyle()
  const box = el('div', 'booqy-update')
  box.setAttribute('role', 'status')
  box.setAttribute('aria-live', 'polite')

  /** Grundläget: text, Ladda om och stäng. `note` efter ett misslyckat försök. */
  const idle = (note?: string) => {
    box.className = 'booqy-update'
    box.style.width = ''
    delete box.dataset.phase
    const text = el('span', 'booqy-update__text', labels.text)
    if (note) text.append(el('span', 'booqy-update__note', note))
    const reload = button('booqy-update__btn booqy-update__reload', labels.reload, () => {
      if (deps.hasUnsaved?.()) confirmUnsaved()
      else start()
    })
    reload.title = labels.hint
    const close = button('booqy-update__close', '×', () => {
      box.remove()
      onDismiss()
    })
    close.setAttribute('aria-label', labels.later)
    close.title = labels.later
    box.replaceChildren(text, reload, close)
    return reload
  }

  const confirmUnsaved = () => {
    box.dataset.phase = 'confirm'
    const text = el('span', 'booqy-update__text', labels.unsaved)
    const cancel = button('booqy-update__btn booqy-update__btn--ghost booqy-update__cancel', labels.cancel, () => idle().focus())
    const anyway = button('booqy-update__btn booqy-update__anyway', labels.reloadAnyway, () => {
      deps.discardUnsaved?.()
      start()
    })
    box.replaceChildren(text, cancel, anyway)
    anyway.focus()
  }

  const start = () => {
    const reduced = reducedMotion()
    // Samma bredd hela vägen, så rutan inte hoppar när innehållet byts.
    const width = box.getBoundingClientRect().width
    box.style.width = width ? `${width}px` : ''
    box.className = 'booqy-update is-loading'
    box.dataset.phase = 'rush'
    const fill = el('span', 'booqy-update__fill')
    const glow = el('span', 'booqy-update__glow')
    const text = el('span', 'booqy-update__text', labels.reloading)
    const pct = el('span', 'booqy-update__pct', '0%')
    const bar = el('span', 'booqy-update__bar')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', '100')
    bar.setAttribute('aria-label', labels.reloading)
    box.replaceChildren(fill, glow, text, pct, bar)

    let shown = -1
    const paint = (p: number) => {
      const n = Math.round(p * 100)
      fill.style.transform = `scaleX(${p})`
      if (n === shown) return
      shown = n
      pct.textContent = `${n}%`
      bar.setAttribute('aria-valuenow', String(n))
      box.dataset.progress = String(n)
    }

    const t0 = performance.now()
    let frame = 0
    let done = false
    const tick = () => {
      if (done) return
      const ms = performance.now() - t0
      paint(reloadProgress(ms))
      if (ms >= RUSH_MS && box.dataset.phase === 'rush') box.dataset.phase = 'crawl'
      frame = requestAnimationFrame(tick)
    }
    if (reduced) {
      paint(0.8)
      box.dataset.phase = 'crawl'
    } else tick()

    const finish = () => {
      done = true
      cancelAnimationFrame(frame)
      box.dataset.phase = 'done'
      box.classList.add('is-done')
      const curtain = el('div', 'booqy-curtain')
      document.body.appendChild(curtain)
      const from = Math.max(shown, 0) / 100
      const t1 = performance.now()
      const glide = () => {
        const k = Math.min((performance.now() - t1) / 200, 1)
        paint(from + (1 - from) * (1 - (1 - k) ** 2))
        if (k < 1) frame = requestAnimationFrame(glide)
      }
      if (reduced) paint(1)
      else {
        glide()
        requestAnimationFrame(() => curtain.classList.add('is-on'))
      }
      window.setTimeout(() => {
        paint(1)
        try {
          sessionStorage.setItem(UPDATED_KEY, '1')
        } catch {
          /* privat läge eller blockerad lagring: hoppa över "Uppdaterad" */
        }
        page.reload()
        // Lever sidan kvar har något stoppat bytet: knappen tillbaka, aldrig ett evigt förlopp.
        window.setTimeout(() => {
          try {
            sessionStorage.removeItem(UPDATED_KEY)
          } catch {
            /* ignorera */
          }
          curtain.remove()
          idle(labels.failed).focus()
        }, FAILSAFE_MS)
      }, reduced ? 0 : FINISH_MS)
    }

    // Snabbfasen spelas alltid klart, så 80 % alltid syns innan 100 %.
    const minWait = new Promise<void>((r) => window.setTimeout(r, reduced ? 0 : RUSH_MS))
    void Promise.all([refreshOwnFiles().catch(() => undefined), minWait]).then(finish)
  }

  idle()
  document.body.appendChild(box)
}

/** Efter en omladdning för uppdatering: en kort "Uppdaterad", en gång. */
export function showUpdatedIfFlagged(labels: Pick<UpdateNoticeLabels, 'updated'> = SV): boolean {
  let flagged = false
  try {
    flagged = sessionStorage.getItem(UPDATED_KEY) === '1'
    if (flagged) sessionStorage.removeItem(UPDATED_KEY)
  } catch {
    return false
  }
  if (!flagged) return false
  injectStyle()
  const toast = el('div', 'booqy-updated')
  toast.setAttribute('role', 'status')
  toast.setAttribute('aria-live', 'polite')
  const badge = el('span', 'booqy-updated__badge')
  badge.setAttribute('aria-hidden', 'true')
  const colors = ['#9e1d26', '#350001', '#c9a27e', '#e8c9a0']
  for (let i = 0; i < 8; i++) {
    const spark = el('span', 'booqy-updated__spark')
    spark.style.setProperty('--a', `${i * 45 + 22}deg`)
    spark.style.background = colors[i % colors.length]
    badge.append(spark)
  }
  badge.append(el('span', 'booqy-updated__leg booqy-updated__leg--a'), el('span', 'booqy-updated__leg booqy-updated__leg--b'))
  toast.append(badge, el('span', 'booqy-updated__text', labels.updated))
  document.body.appendChild(toast)
  window.setTimeout(() => toast.remove(), UPDATED_MS + 100)
  return true
}

/** Startar kontrollen. Returnerar en funktion som stoppar den. */
export function startUpdateNotice(options: UpdateNoticeOptions = {}): () => void {
  const url = options.url ?? '/index.html'
  const intervalMs = options.intervalMs ?? CHECK_EVERY_MS
  const labels: UpdateNoticeLabels = { ...SV, ...options.labels }
  const deps: NoticeDeps = { hasUnsaved: options.hasUnsaved, discardUnsaved: options.discardUnsaved }
  let baseline: string | null = null
  let latest: string | null = null
  let running = false

  showUpdatedIfFlagged(labels)

  const check = async () => {
    if (running) return
    // Första kontrollen (utgångsläget) görs även i en dold flik.
    if (baseline !== null && document.visibilityState !== 'visible') return
    running = true
    try {
      const version = await readVersion(url)
      if (!version) return
      if (baseline === null) baseline = version
      else if (version !== baseline && version !== latest) {
        latest = version
        // "Inte nu" gömmer rutan tills nästa nya version.
        showNotice(labels, deps, () => {
          baseline = latest
        })
      }
    } catch {
      /* offline eller blockerat: försök vid nästa tillfälle */
    } finally {
      running = false
    }
  }

  void check()
  const timer = window.setInterval(() => void check(), intervalMs)
  const onFocus = () => void check()
  const onVisible = () => document.visibilityState === 'visible' && void check()
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.clearInterval(timer)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
