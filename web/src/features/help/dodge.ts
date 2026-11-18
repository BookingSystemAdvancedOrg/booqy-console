import { useEffect, type RefObject } from "react";

/**
 * The floating help button never covers anything that stays put on the screen
 * (a sticky save bar, a fixed notice, a cookie bar): when such an element sits
 * under the button, the button floats up above it, and back down when it is
 * gone. Content that scrolls past is left alone (it can be scrolled free).
 * The lift is the CSS variable --dodge, used by `translate` in the CSS.
 */
/** What the button may never rest on: anything the operator can press or type in. */
const CONTROL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=switch], [role=checkbox], [contenteditable=true]'

/** How long the button stays away after the last scroll (owner 2026-11-14: about a second). */
export const SCROLL_IDLE_MS = 1000

/**
 * It also slides out of view (class is-away) while the page scrolls down and
 * comes back on a scroll up or after SCROLL_IDLE_MS without scrolling, and it
 * stays away while its resting place would sit on top of a button, link or
 * field: it never covers anything. Keyboard focus keeps it in view.
 */
export function useDodge(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !active || typeof document.elementsFromPoint !== 'function') return
    let raf = 0
    let lift = 0
    let scrolledAway = false
    let overControl = false
    let lastY = window.scrollY
    let idle = 0
    // is-away: faded out and not clickable. is-scrolling: also hidden
    // (visibility) while the page scrolls down. Away only because a control
    // is under it, it stays in the tab order, and focus brings it back.
    const apply = () => {
      const focused = document.activeElement === el
      const away = (scrolledAway || overControl) && !focused
      const gone = scrolledAway && !focused
      if (el.classList.contains('is-away') !== away) el.classList.toggle('is-away', away)
      if (el.classList.contains('is-scrolling') !== gone) el.classList.toggle('is-scrolling', gone)
    }
    const pinnedAncestor = (node: Element | null): Element | null => {
      for (let e = node; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        const pos = getComputedStyle(e).position
        if (pos === 'fixed' || pos === 'sticky') return e
      }
      return null
    }
    let shift = 0
    const run = () => {
      raf = 0
      // Where the button rests without the lift, from its CSS bottom and right
      // (not its box, which is mid-move while the lift animates).
      const cs = getComputedStyle(el)
      const vh = window.innerHeight
      const vw = document.documentElement.clientWidth
      const bottom = vh - (parseFloat(cs.bottom) || 0)
      const top = bottom - el.offsetHeight
      const right = vw - (parseFloat(cs.right) || 0)
      const left = right - el.offsetWidth
      // Near the edges: a save bar that ends just inside the round button still lifts it.
      const xs = [left + 2, left + el.offsetWidth / 2, right - 2]
      const ys = [top + 6, top + el.offsetHeight / 2, bottom - 6]
      let obstacle: Element | null = null
      let obstacleTop = Infinity
      for (const x of xs) for (const y of ys) {
        for (const n of document.elementsFromPoint(x, y)) {
          if (el.contains(n)) continue
          const pin = pinnedAncestor(n)
          if (!pin || pin.contains(el)) continue
          const pr = pin.getBoundingClientRect()
          if (pr.height > vh * 0.5) continue // page frames and backgrounds, not bars
          if (pr.bottom > top && pr.top < bottom && pr.top < obstacleTop) {
            obstacleTop = pr.top
            obstacle = pin
          }
        }
      }
      const nextLift = obstacle ? Math.max(0, Math.ceil(bottom - obstacleTop + 10)) : 0
      // Line the button's right edge up with the bar's right edge (owner
      // 2026-11-14: Fråga Booqy ends on the same vertical line as the brown
      // save bar under it). Kept inside the window.
      let nextShift = 0
      if (obstacle) {
        const edge = obstacle.getBoundingClientRect().right
        nextShift = Math.round(right - edge)
        nextShift = Math.min(nextShift, Math.max(0, left - 12)) // not off the left side
        nextShift = Math.max(nextShift, -Math.max(0, vw - 12 - right)) // not off the right side
      }
      if (nextLift !== lift || nextShift !== shift) {
        lift = nextLift
        shift = nextShift
        el.style.setProperty('--dodge', `${lift}px`)
        el.style.setProperty('--dodge-x', `${shift}px`)
      }
      // Where it ends up (lifted and shifted): is a control under it?
      overControl = false
      for (const x of xs) for (const y of ys) {
        for (const n of document.elementsFromPoint(x - nextShift, y - nextLift)) {
          if (el.contains(n) || pinnedAncestor(n)) continue
          const c = n.closest(CONTROL)
          if (c && !c.contains(el) && !c.closest('[aria-hidden="true"], [inert]')) { overControl = true; break }
        }
      }
      apply()
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(run) }
    // The page itself scrolling (not a table or list inside it): down hides, up or a pause brings it back.
    const onPageScroll = () => {
      const y = window.scrollY
      if (y > lastY + 2) scrolledAway = true
      else if (y < lastY - 2) scrolledAway = false
      lastY = y
      window.clearTimeout(idle)
      idle = window.setTimeout(() => { scrolledAway = false; schedule() }, SCROLL_IDLE_MS)
      schedule()
    }
    schedule()
    window.addEventListener('scroll', onPageScroll, { passive: true })
    el.addEventListener('focus', apply)
    el.addEventListener('blur', apply)
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    const tick = window.setInterval(schedule, 1000)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.clearTimeout(idle)
      window.removeEventListener('scroll', onPageScroll)
      el.removeEventListener('focus', apply)
      el.removeEventListener('blur', apply)
      el.classList.remove('is-away', 'is-scrolling')
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      mo.disconnect()
      window.clearInterval(tick)
    }
  }, [ref, active])
}
