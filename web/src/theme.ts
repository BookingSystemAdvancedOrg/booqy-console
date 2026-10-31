import { useCallback, useSyncExternalStore } from "react";
import { THEME_KEY } from "./storageRegistry";

/**
 * Light and dark mode. The choice lives in localStorage (booqy-theme) and
 * on <html data-theme>; public/theme.v2.js sets the attribute before the
 * first paint so the page never flashes light before dark. Without a
 * choice the console is light, like booqy.se; dark is one press away. The
 * same key is used by every Booqy app.
 */

export type Theme = "light" | "dark";

/** What the browser's own frame gets (meta theme-color): the room. */
const THEME_COLOR: Record<Theme, string> = { light: "#f6f1ea", dark: "#1a120e" };

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** The mode right now: what is on <html>, else the stored one, else light. */
export function currentTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (isTheme(attr)) return attr;
  }
  return storedTheme() ?? "light";
}

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Sets the mode on the page (attribute and frame colour) without storing it. */
export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLOR[theme];
  }
  emit();
}

/** Stores the choice and sets it. */
export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode without storage: the choice lasts until reload */
  }
  applyTheme(theme);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // A change in another tab follows here.
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY && isTheme(e.newValue)) applyTheme(e.newValue);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Switches mode with a sweep: the new colours grow out of the button
 * (origin) in a circle until they cover the page (View Transitions).
 * Without browser support, without an origin or with reduced motion it
 * just switches.
 */
export function switchTheme(theme: Theme, origin?: { x: number; y: number }) {
  const doc = document as Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!origin || reduce || typeof doc.startViewTransition !== "function") {
    setTheme(theme);
    return;
  }
  const { x, y } = origin;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = doc.startViewTransition(() => setTheme(theme));
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 700, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
    );
  }, () => {});
}

export function useTheme(): { theme: Theme; toggle: (origin?: { x: number; y: number }) => void; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  const toggle = useCallback((origin?: { x: number; y: number }) => switchTheme(currentTheme() === "dark" ? "light" : "dark", origin), []);
  return { theme, toggle, setTheme };
}
