/** Motion for the Finance page: numbers that count up and turn green or red
 * by how they are doing (src/trend.ts), the change against the previous
 * period, and a damped spring for the rings. With "reduce motion" on,
 * everything shows its final value at once. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Trend, TrendTone } from "../trend";
import { InfoTip } from "./InfoTip";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** How long an overlay takes to leave (ux-motion #18: about half its entry). */
export const EXIT_MS = 130;

/** The exit time to wait for: none with "reduce motion". */
export function exitMs(ms: number = EXIT_MS): number {
  return prefersReducedMotion() ? 0 : ms;
}

/** A capped stagger (ux-motion #3): `step` ms per item, items past `cap` come with the last. */
export function stagger(i: number, step = 40, cap = 6): number {
  return Math.min(Math.max(0, Math.floor(i)), cap) * step;
}

/** Where `trigger`'s centre sits inside `box`, as a CSS transform-origin in px,
 * so an overlay grows from what opened it (ux-motion #11). Null when either is
 * missing or the trigger is not on screen (a keyboard shortcut, a closed menu). */
export function originIn(trigger: Element | null | undefined, box: Element | null | undefined): string | null {
  if (!trigger || !box || !trigger.isConnected) return null;
  const t = trigger.getBoundingClientRect();
  if (t.width === 0 && t.height === 0) return null;
  const b = box.getBoundingClientRect();
  const x = Math.round(t.left + t.width / 2 - b.left);
  const y = Math.round(t.top + t.height / 2 - b.top);
  return `${x}px ${y}px`;
}

// The last control pressed: Safari does not focus a clicked button, so the
// focused element alone does not say what opened an overlay.
let lastPress: { el: Element; at: number } | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (e) => {
    const el = e.target instanceof Element ? e.target.closest("button, a, summary, [role='button'], [role='tab']") : null;
    if (el) lastPress = { el, at: Date.now() };
  }, true);
}

/** The element that opened an overlay: a control pressed in the last second,
 * else the focused one (a keyboard open). Read once, before the overlay takes focus. */
export function useOpener(): Element | null {
  const [opener] = useState<Element | null>(() => {
    if (typeof document === "undefined") return null;
    if (lastPress && Date.now() - lastPress.at < 1000 && lastPress.el.isConnected) return lastPress.el;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  return opener;
}

/** Sets `--origin` on the overlay box to its opener, before the first paint. */
export function useOriginFrom<T extends HTMLElement>(opener: Element | null | undefined) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const origin = originIn(opener, ref.current);
    if (origin) ref.current?.style.setProperty("--origin", origin);
  }, [opener]);
  return ref;
}

/** Fast closing (ux-motion #18): `close()` marks the overlay as closing (put
 * `data-closing` on it, the CSS eases it out) and calls `onClose` after `ms`,
 * at once with "reduce motion". A second close while leaving does nothing. */
export function useClosing(onClose: () => void, ms: number = EXIT_MS): [boolean, () => void] {
  const [closing, setClosing] = useState(false);
  const timer = useRef(0);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = useCallback(() => {
    const wait = exitMs(ms);
    if (wait === 0) { latest.current(); return; }
    if (timer.current) return;
    setClosing(true);
    // Back to open if the owner keeps it (a confirm said no); gone otherwise.
    timer.current = window.setTimeout(() => { timer.current = 0; latest.current(); setClosing(false); }, wait);
  }, [ms]);
  return [closing, close];
}

export interface SpringOptions {
  /** Spring constant: higher = faster. */
  stiffness?: number;
  /** Friction: 2 x sqrt(stiffness) is critically damped (no overshoot). */
  damping?: number;
  /** Where the value starts on mount. */
  from?: number;
  /** How close to the target counts as settled. */
  precision?: number;
}

/** A critically damped spring that settles on `target`, integrated per
 * animation frame (semi-implicit Euler in four substeps). Starts at `from`
 * on mount, so a number counts up; follows every later target. */
export function useSpring(target: number, { stiffness = 170, damping = 26, from = 0, precision = 0.5 }: SpringOptions = {}): number {
  const still = prefersReducedMotion() || typeof requestAnimationFrame !== "function";
  const [value, setValue] = useState(() => (still ? target : from));
  const s = useRef({ x: still ? target : from, v: 0, raf: 0, last: 0 });
  useEffect(() => {
    const state = s.current;
    if (still) {
      state.x = target;
      setValue(target);
      return;
    }
    cancelAnimationFrame(state.raf);
    state.last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.064, Math.max(0.001, (now - state.last) / 1000));
      state.last = now;
      const h = dt / 4;
      for (let i = 0; i < 4; i++) {
        const acceleration = -stiffness * (state.x - target) - damping * state.v;
        state.v += acceleration * h;
        state.x += state.v * h;
      }
      if (Math.abs(state.x - target) < precision && Math.abs(state.v) < precision * 4) {
        state.x = target;
        state.v = 0;
        setValue(target);
        return;
      }
      setValue(state.x);
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(state.raf);
  }, [target, stiffness, damping, precision, still]);
  return value;
}

const COUNT_MS = 1100;

/** Rushes off and slows exponentially towards the end (the same curve as admin's count-up). */
export function easeOutExpo(t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return u >= 1 ? 1 : 1 - 2 ** (-10 * u);
}

/** How far the colour has grown, 0 to 1, soft at both ends. It follows the
 * time, not the value: the value rushes almost to the end at once, and the
 * colour would only blink instead of growing with the figure. */
function growth(u: number): string {
  const t = Math.min(1, Math.max(0, u));
  return ((1 - Math.cos(Math.PI * t)) / 2).toFixed(3);
}

/** A figure that counts up to its value, exponentially slowing as it gets
 * close, and counts again from where it stood when the value changes. While
 * it first counts up it sets `--count` (0 to 1) on itself, so a green or red
 * figure (.trend-value--good/--bad) starts in the normal print and takes its
 * colour as it grows. With "reduce motion" the final value shows at once. */
export function CountUp({ value, format }: { value: number | null | undefined; format: (n: number) => string }) {
  const target = value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value);
  const text = target === null ? "-" : format(target);
  const ref = useRef<HTMLSpanElement>(null);
  const formatRef = useRef(format);
  formatRef.current = format;
  const shown = useRef<number | null>(null);
  const grown = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current ?? 0;
    if (target === null || from === target || prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      el.textContent = text;
      shown.current = target;
      grown.current = true;
      return;
    }
    // The colour grows only the first time; later counts keep it.
    const colour = !grown.current;
    grown.current = true;
    const fmt = formatRef.current;
    const start = performance.now();
    let raf = 0;
    let finished = false;
    let current = from;
    const frame = (now: number) => {
      const u = (now - start) / COUNT_MS;
      const p = easeOutExpo(u);
      if (p >= 1) {
        el.textContent = text;
        el.style.removeProperty("--count");
        shown.current = target;
        finished = true;
        return;
      }
      current = from + (target - from) * p;
      el.textContent = fmt(current);
      if (colour) el.style.setProperty("--count", growth(u));
      raf = requestAnimationFrame(frame);
    };
    el.textContent = fmt(from);
    if (colour) el.style.setProperty("--count", growth(0));
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      el.style.removeProperty("--count");
      // Stopped before the end (StrictMode runs effects twice, or the value changed): go on from where it was.
      if (!finished) {
        shown.current = current;
        if (colour) grown.current = false;
      }
    };
  }, [target, text]);

  // Every digit has the same width, so the row does not jump while it counts.
  return <span ref={ref} className="count-num">{text}</span>;
}

/** A green figure lights up once as it lands, after the count-up, as a small
 * reward. Never with "reduce motion"; red gets no motion at all. Put the ref
 * on the element with the figure. */
export function useTrendPop<T extends HTMLElement>(tone: TrendTone, delayMs = 700) {
  const ref = useRef<T>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || done.current || tone !== "good") return;
    done.current = true;
    if (prefersReducedMotion()) return;
    el.style.animationDelay = `${delayMs}ms`;
    el.classList.add("trend-pop");
    const end = () => el.classList.remove("trend-pop");
    el.addEventListener("animationend", end, { once: true });
    return () => el.removeEventListener("animationend", end);
  }, [tone, delayMs]);
  return ref;
}

/** The same arrows as admin's trend-up and trend-down icons. */
function TrendArrow({ direction }: { direction: "up" | "down" }) {
  return (
    <svg className="trend-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={direction === "up" ? "M3.5 17.5l6-6 4 4 7-7.5M15 8h5.5v5.5" : "M3.5 6.5l6 6 4-4 7 7.5M15 16h5.5v-5.5"} />
    </svg>
  );
}

/** The change against the comparison, as a small chip: an arrow and "+12 %",
 * no words (a tile shows only its label and number): "unchanged" reads
 * "0 %" and "new" (from zero) is the arrow alone; for screen readers the
 * whole sentence. Green or red by the trend's tone, the normal print when it
 * is noise. Nothing to compare with: no chip. */
export function Delta({ trend }: { trend: Trend }) {
  if (!trend.text) return null;
  const fresh = trend.text === "new";
  const text = trend.direction === "flat" ? "0\u00a0%" : fresh ? "" : trend.text;
  const arrow = trend.direction === "down" ? "down" : trend.direction === "up" && (!fresh || trend.tone !== "neutral") ? "up" : null;
  if (!text && !arrow) return null;
  // A tap, hover or focus says what it compares with ("Unchanged vs previous period"): the title alone never shows on touch.
  const said = trend.spoken.charAt(0).toUpperCase() + trend.spoken.slice(1);
  return (
    <InfoTip label={said} className="delta-tip" trigger={
      <span className={`delta delta--${trend.tone}`}>
        {arrow && <TrendArrow direction={arrow} />}
        {text && <span aria-hidden="true">{text}</span>}
        <span className="sr-only">{trend.spoken}</span>
      </span>
    }>{said}</InfoTip>
  );
}

export function deltaPct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
