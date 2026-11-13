/**
 * See-through desktop window. Booqy's desktop shell (desktop/main.cjs) adds
 * "BooqyGlass/<mode>" to the user agent when the window is translucent:
 * vibrancy (macOS), acrylic (Windows 11) or tint (Linux, no blur). <html>
 * then gets is-desktop-glass and data-desktop-glass=<mode>, and the CSS makes
 * the page clear so the desktop shows through. In a browser nothing happens.
 */
import { showDesktopHint } from './desktopHint'
import { installGlassBackdrop } from './glassBackdrop'

export type DesktopGlass = 'vibrancy' | 'acrylic' | 'tint'

export function desktopGlassMode(userAgent: string): DesktopGlass | null {
  const m = /\bBooqyGlass\/(vibrancy|acrylic|tint)\b/.exec(userAgent)
  return m ? (m[1] as DesktopGlass) : null
}

export function installDesktopGlass(): DesktopGlass | null {
  installGlassBackdrop()
  // The removed Background setting kept a picture here; clean it up.
  try {
    localStorage.removeItem('booqy-backdrop')
  } catch {
    // no storage, nothing to clean
  }
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return null
  const mode = desktopGlassMode(navigator.userAgent)
  if (!mode) {
    // In a browser: once, a tip about the app (it sees the desktop, a page cannot).
    window.setTimeout(showDesktopHint, 2500)
    return null
  }
  const root = document.documentElement
  root.classList.add('is-desktop-glass')
  root.dataset.desktopGlass = mode
  return mode
}
