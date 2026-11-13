import { APP_HINT_KEY } from './storageRegistry'

/**
 * Once, only in a desktop browser: a small glass note that the desktop app
 * shows the desktop and other windows through the glass. A web page cannot
 * see what is behind the browser (an OS security boundary), so the browser
 * keeps Booqy's backdrop instead.
 */
const HREF = '/settings#desktop-app'
const STYLE_ID = 'booqy-app-hint-style'

const CSS = `.booqy-app-hint{position:fixed;left:16px;bottom:16px;z-index:270;display:flex;align-items:center;gap:10px;max-width:min(420px,calc(100vw - 32px));padding:10px 10px 10px 16px;border-radius:999px;
background:var(--glass-pop) var(--liquid-sheen,none);color:var(--ink);box-shadow:var(--liquid-edge,none),var(--liquid-depth,none);
-webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6);font:500 14px/1.35 var(--sans,system-ui)}
.booqy-app-hint a{color:inherit;font-weight:700;text-underline-offset:3px;white-space:nowrap}
.booqy-app-hint button{appearance:none;border:0;background:transparent;color:inherit;width:32px;height:32px;border-radius:999px;cursor:default;font:inherit;opacity:.7}
.booqy-app-hint button:hover,.booqy-app-hint button:focus-visible{background:var(--glass-fill);opacity:1}
.booqy-app-hint button:focus-visible,.booqy-app-hint a:focus-visible{outline:none;box-shadow:0 0 0 3px var(--field-ring)}`

function seen(): boolean {
  try {
    return localStorage.getItem(APP_HINT_KEY) === '1'
  } catch {
    return true
  }
}

function remember() {
  try {
    localStorage.setItem(APP_HINT_KEY, '1')
  } catch {
    // without storage the note shows only this time
  }
}

export function showDesktopHint(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  if (document.documentElement.classList.contains('is-desktop-glass')) return
  if (!window.matchMedia?.('(pointer: fine) and (min-width: 768px)').matches) return
  if (/iPhone|iPad|Android/.test(navigator.userAgent) || seen()) return
  remember()
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }
  const box = document.createElement('div')
  box.className = 'booqy-app-hint'
  box.setAttribute('role', 'status')
  const text = document.createElement('span')
  text.append('Want to see your desktop through the glass? ')
  const link = document.createElement('a')
  link.href = HREF
  link.textContent = 'Download the app'
  link.addEventListener('click', (e) => {
    e.preventDefault()
    box.remove()
    window.history.pushState({}, '', HREF)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  text.append(link)
  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close')
  close.textContent = '✕'
  close.addEventListener('click', () => box.remove())
  box.append(text, close)
  document.body.appendChild(box)
}
