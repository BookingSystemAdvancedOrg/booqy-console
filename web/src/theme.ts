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

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  const toggle = useCallback(() => setTheme(currentTheme() === "dark" ? "light" : "dark"), []);
  return { theme, toggle, setTheme };
}
