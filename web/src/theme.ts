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

/**
 * The desktop app reads data-glass-theme (not data-theme) for the system
 * glass. During a switch it stays on the old theme until the sweep is done,
 * so the old frame never sits over the new glass.
 */
let holdGlass = false;

/** Sets the mode on the page (attribute and frame colour) without storing it. */
export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  if (!holdGlass) document.documentElement.dataset.glassTheme = theme;
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
 * Switches the theme with a sweep: the new colours grow in a circle from the
 * click point (View Transitions, 480 ms). During the switch every transition
 * is off (.theme-switching), so no surface fades through grey.
 *
 * Desktop app: the system glass cannot be in two themes at once. The old frame
 * therefore stays on the old glass for the whole sweep, and the new frame gets
 * a dense backing in roughly the new glass colour (.theme-settling). When the
 * sweep is done the shell switches the glass (data-glass-theme) and the backing
 * fades out in 200 ms. Reduced motion or no View Transitions: instant switch.
 */
export function switchTheme(theme: Theme, origin?: { x: number; y: number }) {
  const root = document.documentElement;
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> }
  };
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || typeof doc.startViewTransition !== "function") {
    setTheme(theme);
    return;
  }
  const desktop = root.classList.contains("is-desktop-glass");
  root.classList.add("theme-switching");
  if (desktop) {
    root.dataset.glassTheme = currentTheme();
    holdGlass = true;
  }
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = doc.startViewTransition(() => setTheme(theme));
  const done = () => {
    if (desktop) {
      holdGlass = false;
      root.dataset.glassTheme = theme;
      // The shell switches the glass within a couple of frames; then the backing fades.
      window.setTimeout(() => {
        root.classList.remove("theme-switching");
        requestAnimationFrame(() => root.classList.remove("theme-settling"));
      }, 120);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  };
  transition.finished.then(done, done);
  transition.ready.then(() => {
    const sweep = root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 480, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
    );
    // The circle covers everything: now the page gets the new backing.
    if (desktop) sweep.finished.then(() => root.classList.add("theme-settling"), () => root.classList.add("theme-settling"));
  }, () => {});
}

export function useTheme(): { theme: Theme; toggle: (origin?: { x: number; y: number }) => void; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  const toggle = useCallback((origin?: { x: number; y: number }) => switchTheme(currentTheme() === "dark" ? "light" : "dark", origin), []);
  return { theme, toggle, setTheme };
}
