/** Motion for the Finance page: numbers that count up on a damped spring,
 * and the change against the previous period. With "reduce motion" on,
 * everything shows its final value at once. */
import { useEffect, useRef, useState } from "react";
import { fmtPct } from "../finance";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

/** A figure that counts up to its value. */
export function CountUp({ value, format, precision }: { value: number | null | undefined; format: (n: number) => string; precision?: number }) {
  const target = value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value);
  const shown = useSpring(target ?? 0, { precision: precision ?? (Math.abs(target ?? 0) < 100 ? 0.01 : 0.5) });
  if (target === null) return <>-</>;
  return <>{format(shown)}</>;
}

/** Change against the previous period, as a stamp: up or down and by how
 * much. `invert` when lower is better (cost). */
export function Delta({ current, previous, invert = false, label = "vs previous period" }: {
  current: number | null | undefined; previous: number | null | undefined; invert?: boolean; label?: string;
}) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return <span className="delta delta--none">no comparison yet</span>;
  }
  const pct = deltaPct(Number(current), Number(previous));
  if (pct === null) return <span className="delta delta--none">nothing in the previous period</span>;
  const flat = Math.abs(pct) < 0.05;
  const better = invert ? pct < 0 : pct > 0;
  const tone = flat ? "flat" : better ? "good" : "bad";
  const arrow = flat ? "=" : pct > 0 ? "▲" : "▼";
  return (
    <span className={`delta delta--${tone}`} title={`${fmtPct(Math.abs(pct))} ${label}`}>
      <span aria-hidden>{arrow}</span> {fmtPct(Math.abs(pct))} <span className="delta__label">{label}</span>
    </span>
  );
}

export function deltaPct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
