import { showDownloadNav } from './desktopDownloads'
import { APP_HINT_KEY } from './storageRegistry'

/**
 * Once, only in a desktop browser: a small note that the desktop app shows
 * the desktop and other windows through the glass. A web page cannot see
 * what is behind the browser (an OS security boundary), so the browser keeps
 * Booqy's backdrop instead. The note sits in the page flow (DesktopHint.tsx),
 * never floating over inputs or the menu.
 */
export const APP_HINT_HREF = '/settings#desktop-app'

function seen(): boolean {
  try {
    return localStorage.getItem(APP_HINT_KEY) === '1'
  } catch {
    return true
  }
}

/** Never inside the desktop app (also with reduced transparency) and only in a desktop browser, the same rule as the menu; once. */
export function shouldShowDesktopHint(): boolean {
  if (typeof window === 'undefined') return false
  return showDownloadNav() && !seen()
}

/** Shown once: remembered as soon as it is on screen. */
export function rememberDesktopHint(): void {
  try {
    localStorage.setItem(APP_HINT_KEY, '1')
  } catch {
    // without storage the note shows only this time
  }
}
