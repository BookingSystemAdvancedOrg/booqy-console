import { useCallback, useSyncExternalStore } from "react";
import { THEME_KEY } from "./storageRegistry";

/**
 * Light and dark mode. The choice lives in localStorage (booqy-theme) and
 * on <html data-theme>; public/theme.v1.js sets the attribute before the
 * first paint so the page never flashes light before dark. Without a
 * choice the console follows the system, also when it changes while the
 * page is open. The same key is used by every Booqy app.
 */

export type Theme = "light" | "dark";

/** What the browser's own frame gets (meta theme-color): the wall. */
const THEME_COLOR: Record<Theme, string> = { light: "#350001", dark: "#1f0002" };
const DARK_QUERY = "(prefers-color-scheme: dark)";

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

/** The system setting; light where it cannot be read (tests). */
export function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** The mode right now: what is on <html>, else the stored one, else the system's. */
export function currentTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (isTheme(attr)) return attr;
  }
  return storedTheme() ?? systemTheme();
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
  // Without a choice of its own the page follows the system, also when it flips.
  const media = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
  const onMedia = () => {
    if (!storedTheme()) applyTheme(systemTheme());
  };
  media?.addEventListener("change", onMedia);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
    media?.removeEventListener("change", onMedia);
  };
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  const toggle = useCallback(() => setTheme(currentTheme() === "dark" ? "light" : "dark"), []);
  return { theme, toggle, setTheme };
}
