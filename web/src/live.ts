import { useEffect, useRef } from "react";

/**
 * Live data: what is on screen is refetched quietly, so changes made by
 * another operator (or by a restaurant in its admin) show up by themselves.
 * Nobody reloads the page for data; "Reload" is only for a new app version.
 *
 * One shared pulse for the whole console:
 * - every 15 s while the tab is visible (paused while it is hidden),
 * - at once when the window gets focus, the tab becomes visible again or the
 *   network is back ("online"),
 * - right after an own save (api.ts dispatches LIVE_SAVED_EVENT).
 *
 * useLoad (components/ui.tsx) hooks every page onto it. A failed refetch
 * waits longer before the next (15 s, 30 s, 60 s ... at most 5 min); focus
 * and "online" try again at once. Quiet refetches show no loading and no busy
 * bar (quietly()), and keep what is on screen when they fail. Unchanged
 * answers are cheap: the API answers 304 to If-None-Match where it can.
 */

export const LIVE_INTERVAL_MS = 15_000;
export const LIVE_MAX_BACKOFF_MS = 5 * 60_000;
/** Dispatched on window after every successful write (and after a 409). */
export const LIVE_SAVED_EVENT = "booqy:data-changed";

export type LiveReason = "interval" | "focus" | "online" | "saved";
type Listener = (reason: LiveReason) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastWake = 0;
let detach: (() => void) | null = null;

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const online = () => typeof navigator === "undefined" || navigator.onLine !== false;

function emit(reason: LiveReason) {
  for (const l of [...listeners]) l(reason);
}

function startTimer() {
  if (timer === null) timer = setInterval(() => visible() && online() && emit("interval"), LIVE_INTERVAL_MS);
}

function stopTimer() {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** Focus and visibility often arrive together: one refetch is enough. */
function wake() {
  if (!visible()) return;
  const now = Date.now();
  if (now >= lastWake && now - lastWake < 1000) return;
  lastWake = now;
  emit("focus");
}

function attach() {
  if (typeof window === "undefined") return;
  const onVisibility = () => {
    if (visible()) {
      startTimer();
      wake();
    } else {
      stopTimer();
    }
  };
  const onOnline = () => emit("online");
  const onSaved = () => emit("saved");
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  window.addEventListener(LIVE_SAVED_EVENT, onSaved);
  if (visible()) startTimer();
  detach = () => {
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener(LIVE_SAVED_EVENT, onSaved);
    stopTimer();
    lastWake = 0;
    detach = null;
  };
}

export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  if (!detach) attach();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach?.();
  };
}

/** How long to wait after `failures` failed refetches in a row. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(LIVE_MAX_BACKOFF_MS, LIVE_INTERVAL_MS * 2 ** failures);
}

/** Tell every live page that something was saved (refetch now). */
export function notifySaved(detail: Record<string, unknown> = {}): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(LIVE_SAVED_EVENT, { detail }));
}

/**
 * Refetch quietly on the pulse. A rejected promise or `false` counts as a
 * failure (longer wait before the next one). Never two at once per hook.
 */
export function useLiveRefresh(refetch: () => unknown, opts: { enabled?: boolean } = {}): void {
  const latest = useRef(refetch);
  useEffect(() => {
    latest.current = refetch;
  });
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    let running = false;
    let failures = 0;
    let notBefore = 0;
    return subscribeLive(async (reason) => {
      if (running) return;
      if (reason === "online") failures = 0;
      if (reason === "interval" && Date.now() < notBefore) return;
      running = true;
      try {
        if ((await latest.current()) === false) throw new Error("refetch failed");
        failures = 0;
        notBefore = 0;
      } catch {
        failures += 1;
        notBefore = Date.now() + backoffMs(failures);
      } finally {
        running = false;
      }
    });
  }, [enabled]);
}

/** Same value (deep, as JSON)? Then the old object is kept and nothing re-renders. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

let quietDepth = 0;

/** True while a quiet (live) refetch is starting its requests: no busy bar for those. */
export function isQuiet(): boolean {
  return quietDepth > 0;
}

/**
 * Runs `load` as a quiet refetch: the requests it starts right away (the
 * usual `() => api.x(id)`) skip the busy bar.
 */
export function quietly<T>(load: () => Promise<T>): Promise<T> {
  quietDepth += 1;
  try {
    return load();
  } finally {
    quietDepth -= 1;
  }
}
