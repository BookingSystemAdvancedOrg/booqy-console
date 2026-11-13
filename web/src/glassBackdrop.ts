import { GLASS_BACKDROP_KEY } from './storageRegistry'

/**
 * The background behind the glass ("Background" in Settings, Appearance and sound).
 *
 * - See-through (the default, nothing stored): in the desktop app whatever is
 *   behind the window shows through; in a browser Booqy's backdrop.
 * - Colour (only when chosen): the glass sits over a soft field in the chosen
 *   colour. In the desktop app the field covers the system glass completely,
 *   so nothing changes in the shell and nothing can flash.
 *
 * An unknown or broken stored value counts as no choice: nobody is ever moved
 * to Colour without choosing it. Same key and values as Booqy Admin.
 */

export type GlassBackdrop = { mode: 'clear' } | { mode: 'colour'; colour: string }

export const SWATCHES: readonly { name: string; colour: string }[] = [
  { name: 'Wine', colour: '#6b1d24' },
  { name: 'Walnut', colour: '#5a3a26' },
  { name: 'Sand', colour: '#c9ae8c' },
  { name: 'Sage', colour: '#7f9479' },
  { name: 'Slate', colour: '#566370' },
  { name: 'Plum', colour: '#5f3a57' },
]

const HEX = /^#[0-9a-f]{6}$/i

export function parseGlassBackdrop(value: string | null | undefined): GlassBackdrop {
  return value && HEX.test(value) ? { mode: 'colour', colour: value.toLowerCase() } : { mode: 'clear' }
}

export function readGlassBackdrop(): GlassBackdrop {
  try {
    return parseGlassBackdrop(localStorage.getItem(GLASS_BACKDROP_KEY))
  } catch {
    return { mode: 'clear' }
  }
}

export function applyGlassBackdrop(b: GlassBackdrop, root: HTMLElement = document.documentElement): void {
  if (b.mode === 'colour') {
    root.dataset.glassBackdrop = 'colour'
    root.style.setProperty('--user-colour', b.colour)
  } else {
    delete root.dataset.glassBackdrop
    root.style.removeProperty('--user-colour')
  }
}

const listeners = new Set<() => void>()
export function subscribeGlassBackdrop(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function store(b: GlassBackdrop) {
  try {
    if (b.mode === 'colour') localStorage.setItem(GLASS_BACKDROP_KEY, b.colour)
    else localStorage.removeItem(GLASS_BACKDROP_KEY)
  } catch {
    // without storage the choice lasts until the page reloads
  }
}

/** Stores and shows the choice with the same sweep as light/dark (from the click point). */
export function setGlassBackdrop(b: GlassBackdrop, origin?: { x: number; y: number }): void {
  const next = b.mode === 'colour' ? parseGlassBackdrop(b.colour) : b
  store(next)
  const root = document.documentElement
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> }
  }
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const update = () => {
    applyGlassBackdrop(next, root)
    for (const fn of listeners) fn()
  }
  if (reduce || typeof doc.startViewTransition !== 'function') {
    update()
    return
  }
  root.classList.add('theme-switching')
  const x = origin?.x ?? window.innerWidth / 2
  const y = origin?.y ?? window.innerHeight / 2
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
  const transition = doc.startViewTransition(update)
  const done = () => requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')))
  transition.finished.then(done, done)
  transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 480, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', pseudoElement: '::view-transition-new(root)' },
    )
  }, () => {})
}

export function installGlassBackdrop(): void {
  if (typeof document === 'undefined') return
  applyGlassBackdrop(readGlassBackdrop())
  window.addEventListener('storage', (e) => {
    if (e.key === GLASS_BACKDROP_KEY) {
      applyGlassBackdrop(readGlassBackdrop())
      for (const fn of listeners) fn()
    }
  })
}
