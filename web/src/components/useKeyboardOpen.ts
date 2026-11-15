import { useEffect, useState } from "react";

/** The phone layout: the bottom bar instead of the side menu (same width as tabbar.css). */
export const PHONE_NAV_QUERY = "(max-width: 760px)";

const mq = (query: string): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;

/** A media query as state. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => mq(query)?.matches ?? false);
  useEffect(() => {
    const m = mq(query);
    if (!m) return;
    const update = () => setOn(m.matches);
    update();
    m.addEventListener?.("change", update);
    return () => m.removeEventListener?.("change", update);
  }, [query]);
  return on;
}

const TYPING = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=file]):not([type=color]), textarea, select, [contenteditable=true], [contenteditable='']";

/**
 * Phones: html.has-tabbar while the bottom bar is in use (the page makes room
 * for it), and html.kb-open while the on-screen keyboard is up, so the bar
 * steps aside instead of riding on top of the keyboard. Touch screens only:
 * a laptop with a narrow window has no on-screen keyboard.
 */
export function useKeyboardOpen(phone: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("has-tabbar", phone);
    if (!phone) { root.classList.remove("kb-open"); return; }
    const coarse = mq("(pointer: coarse)")?.matches ?? false;
    if (!coarse) return () => root.classList.remove("has-tabbar");
    const vv = window.visualViewport;
    let focused = false;
    const update = () => {
      const shrunk = !!vv && vv.height < window.innerHeight - 150;
      root.classList.toggle("kb-open", focused || shrunk);
    };
    const onIn = (e: FocusEvent) => { focused = !!(e.target as Element | null)?.matches?.(TYPING); update(); };
    const onOut = () => { focused = false; window.setTimeout(update, 60); };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    vv?.addEventListener("resize", update);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      vv?.removeEventListener("resize", update);
      root.classList.remove("kb-open", "has-tabbar");
    };
  }, [phone]);
}
