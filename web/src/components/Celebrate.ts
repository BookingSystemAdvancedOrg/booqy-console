/** One peak-end moment for the console's rare finishes (ux-motion #19, #9).
 *
 * - "step": a consequential step done (a billing run, a domain connected, a
 *   step of New customer): the element pops 0.94 -> 1.03 -> 1 in 360 ms, a
 *   tick inside it draws in 300 ms, a chime. No sparks.
 * - "finish": the end of onboarding a customer (Create, the customer going
 *   live): the element pops on a spring in 520 ms, confetti for 1.6 s, the
 *   fanfare.
 *
 * With "reduce motion" nothing moves: the sound stays (as the click does).
 * Sound follows the sound setting (press.ts). With an `id` it fires at most
 * once per id per session, so a reload or a live refresh never repeats it. */
import { playChime } from "../press";
import { prefersReducedMotion } from "./motion";
import { confetti } from "./StepFlow";

export type CelebrateKind = "step" | "finish";

const KEY = "booqy-celebrated";
/** How long the confetti falls for a finish. */
export const FINISH_CONFETTI_MS = 1600;

function seen(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** True the first time an id is claimed in this session; false after that. */
export function claimOnce(id: string): boolean {
  const list = seen();
  if (list.includes(id)) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...list, id].slice(-50)));
  } catch {
    /* no storage: it may fire again after a reload, which is fine */
  }
  return true;
}

/** Plays the moment on `el` (may be null: sound and confetti only). Returns
 * false when it did not fire (already celebrated under this id). */
export function celebrate(el: Element | null, kind: CelebrateKind, id?: string): boolean {
  if (id && !claimOnce(id)) return false;
  playChime(kind === "finish" ? "fanfare" : "chime");
  if (prefersReducedMotion()) return true;
  if (el) {
    const cls = `celebrate--${kind}`;
    el.classList.remove(cls);
    // restart the pop if it is already there (a second run on the same card)
    void (el as HTMLElement).offsetWidth;
    el.classList.add(cls);
    window.setTimeout(() => el.classList.remove(cls), 1200);
  }
  if (kind === "finish") confetti(120, FINISH_CONFETTI_MS);
  return true;
}
