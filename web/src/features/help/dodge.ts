import { useEffect, type RefObject } from "react";

/**
 * The floating help button never covers anything that stays put on the screen
 * (a sticky save bar, a fixed notice, a cookie bar): when such an element sits
 * under the button, the button floats up above it, and back down when it is
 * gone. Content that scrolls past is left alone (it can be scrolled free).
 * The lift is the CSS variable --dodge, used by `translate` in the CSS.
 */
export function useDodge(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !active || typeof document.elementsFromPoint !== 'function') return
    let raf = 0
    let lift = 0
    const pinnedAncestor = (node: Element | null): Element | null => {
      for (let e = node; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        const pos = getComputedStyle(e).position
        if (pos === 'fixed' || pos === 'sticky') return e
      }
      return null
    }
    const run = () => {
      raf = 0
      const r = el.getBoundingClientRect()
      // Where the button rests without the lift, from its CSS bottom (not its
      // box, which is mid-move while the lift animates).
      const vh = window.innerHeight
      const bottom = vh - (parseFloat(getComputedStyle(el).bottom) || 0)
      const top = bottom - el.offsetHeight
      const xs = [r.left + 6, r.left + r.width / 2, r.right - 6]
      const ys = [top + 6, top + el.offsetHeight / 2, bottom - 6]
      let obstacleTop = Infinity
      for (const x of xs) for (const y of ys) {
        for (const n of document.elementsFromPoint(x, y)) {
          if (el.contains(n)) continue
          const pin = pinnedAncestor(n)
          if (!pin || pin.contains(el)) continue
          const pr = pin.getBoundingClientRect()
          if (pr.height > vh * 0.5) continue // page frames and backgrounds, not bars
          if (pr.bottom > top && pr.top < bottom) obstacleTop = Math.min(obstacleTop, pr.top)
        }
      }
      const next = obstacleTop === Infinity ? 0 : Math.max(0, Math.ceil(bottom - obstacleTop + 10))
      if (next !== lift) {
        lift = next
        el.style.setProperty('--dodge', `${lift}px`)
      }
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(run) }
    schedule()
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    const tick = window.setInterval(schedule, 1000)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      mo.disconnect()
      window.clearInterval(tick)
    }
  }, [ref, active])
}
