/** The tooltip every console chart shares: hover, tap, or tab to a chart
 * and walk it with the arrow keys, and the point's label, value and (with
 * more than one series) series name show. Each chart draws its own hit
 * areas and says where the tip goes, in its SVG's own coordinates. */
import { useEffect, useState } from "react";
import type { FocusEvent, KeyboardEvent, PointerEvent } from "react";

export type TipTone = "ink" | "red" | "warn" | "ok" | "steel";
export interface TipRow { label?: string; value: string; tone?: TipTone; line?: boolean }
export interface TipContent { heading: string; rows: TipRow[]; note?: string }

export interface ChartTipState {
  active: number | null;
  set: (i: number | null) => void;
  /** The chart's <svg>, once drawn. */
  svg: SVGSVGElement | null;
  /** Spread on the chart's <svg>: focus, arrow keys, the mouse leaving. */
  surface: {
    ref: (el: SVGSVGElement | null) => void;
    tabIndex: number;
    onKeyDown: (e: KeyboardEvent<SVGSVGElement>) => void;
    onFocus: (e: FocusEvent<SVGSVGElement>) => void;
    onBlur: () => void;
    onPointerLeave: (e: PointerEvent<SVGSVGElement>) => void;
  };
  /** Spread on one point's hit area. */
  hit: (i: number) => { onPointerEnter: () => void; onPointerDown: () => void };
}

export function useChartTip(count: number): ChartTipState {
  const [active, setActive] = useState<number | null>(null);
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const shown = active !== null && active < count ? active : null;

  // A tap outside the chart closes the tip (a phone has no "leave").
  useEffect(() => {
    if (shown === null) return;
    const close = (e: globalThis.PointerEvent) => {
      const host = svg?.parentElement;
      if (host && e.target instanceof Node && !host.contains(e.target)) setActive(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [shown, svg]);

  const move = (step: number) => setActive((cur) => Math.max(0, Math.min(count - 1, (cur ?? -1) + step)));
  const keys: Record<string, () => void> = {
    ArrowRight: () => move(1), ArrowDown: () => move(1),
    ArrowLeft: () => move(-1), ArrowUp: () => move(-1),
    Home: () => setActive(0), End: () => setActive(count - 1),
    Escape: () => setActive(null),
  };

  return {
    active: shown,
    set: setActive,
    svg,
    surface: {
      ref: setSvg,
      tabIndex: count > 0 ? 0 : -1,
      onKeyDown: (e) => {
        const act = keys[e.key];
        if (!act || count === 0) return;
        e.preventDefault();
        act();
      },
      onFocus: (e) => {
        // Keyboard only: a click already picks the point under the mouse.
        let keyboard = true;
        try { keyboard = e.currentTarget.matches(":focus-visible"); } catch { keyboard = true; }
        if (keyboard && count > 0) setActive((cur) => cur ?? 0);
      },
      onBlur: () => setActive(null),
      onPointerLeave: (e) => { if (e.pointerType === "mouse") setActive(null); },
    },
    hit: (i) => ({ onPointerEnter: () => setActive(i), onPointerDown: () => setActive(i) }),
  };
}

