/** A ring (donut) that shares a total between a few segments, drawn on a
 * spring so the arcs grow in, with the hero share in the middle and a
 * legend that states every share, so colour is never the only signal.
 * Hover, tap or arrow keys show one segment's share and amount (ChartTip). */
import { useId } from "react";
import { fmtPct, fmtSek } from "../finance";
import { ChartTip } from "./ChartTip";
import { useChartTip } from "./chartTipState";
import { useSpring } from "./motion";

export type RingTone = "ink" | "red" | "warn" | "ok" | "steel";
export interface RingSegment { key: string; label: string; value: number; tone: RingTone }

const SIZE = 150;
const R = 58;
const C = 2 * Math.PI * R;

export function Ring({ title, segments, total, centerLabel, empty, format = fmtSek, valueLabel = "Amount" }: {
  title: string;
  segments: RingSegment[];
  /** The whole the shares are of; segments beyond it are clipped. */
  total: number;
  centerLabel: string;
  /** Shown when there is nothing to share. */
  empty: string;
  format?: (n: number) => string;
  /** What the value is, in the tooltip. */
  valueLabel?: string;
}) {
  const id = useId();
  const tip = useChartTip(total > 0 ? segments.length : 0);
  const progress = useSpring(1, { precision: 0.002, stiffness: 120, damping: 22 });
  const shares = segments.map((s) => ({ ...s, share: total > 0 ? Math.max(0, Math.min(1, Math.max(0, s.value) / total)) : 0 }));
  const hero = shares[0];
  let offset = 0;
  const arcs = shares.map((s) => {
    const length = C * s.share * progress;
    const arc = { ...s, dash: `${length} ${Math.max(0, C - length)}`, offset: -offset };
    offset += length;
    return arc;
  });
  // Where each segment starts once fully grown, as a share of the turn.
  const starts = shares.reduce<number[]>((acc, _s, i) => [...acc, i === 0 ? 0 : acc[i - 1] + shares[i - 1].share], []);
  // The segment under the pointer: the angle from the centre (clockwise
  // from twelve) and the distance to the ring, so the middle is left out.
  const pick = (e: { clientX: number; clientY: number }) => {
    const svg = tip.svg;
    if (!svg || total <= 0) return;
    const r = svg.getBoundingClientRect();
    const dx = ((e.clientX - r.left) / r.width) * SIZE - SIZE / 2;
    const dy = ((e.clientY - r.top) / r.height) * SIZE - SIZE / 2;
    const dist = Math.hypot(dx, dy);
    if (dist < R - 16 || dist > R + 16) return tip.set(null);
    const turn = ((Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI);
    const i = shares.findIndex((s, k) => turn >= starts[k] && turn < starts[k] + s.share);
    tip.set(i >= 0 ? i : null);
  };
  const a = tip.active;
  const as = a !== null ? shares[a] : null;
  const mid = as ? (starts[a!] + as.share / 2) * 2 * Math.PI - Math.PI / 2 : 0;
  return (
    <figure className="ring" aria-labelledby={`${id}-t`}>
      <figcaption className="ring__title" id={`${id}-t`}>{title}</figcaption>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="ring__svg chart-tip-surface" role="img"
           aria-label={`${title}: ${shares.map((s) => `${s.label} ${fmtPct(s.share * 100)}`).join(", ")}`}
           {...tip.surface} onPointerMove={pick} onPointerDown={pick}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} className="ring__track" />
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {arcs.map((arc, i) => (
            <circle key={arc.key} cx={SIZE / 2} cy={SIZE / 2} r={R} className={`ring__seg ring__seg--${arc.tone}${a === i ? " ring__seg--on" : ""}`}
                    strokeDasharray={arc.dash} strokeDashoffset={arc.offset} />
          ))}
        </g>
        {total > 0 && hero ? (
          <>
            <text x={SIZE / 2} y={SIZE / 2 - 2} textAnchor="middle" className="ring__value">{fmtPct(hero.share * 100 * progress)}</text>
            <text x={SIZE / 2} y={SIZE / 2 + 18} textAnchor="middle" className="ring__center-label">{centerLabel}</text>
          </>
        ) : (
          <text x={SIZE / 2} y={SIZE / 2 + 4} textAnchor="middle" className="ring__center-label">{empty}</text>
        )}
      </svg>
      <ChartTip tip={tip} at={as ? { x: SIZE / 2 + Math.cos(mid) * R, y: SIZE / 2 + Math.sin(mid) * R - 8 } : null}
                content={as ? { heading: as.label, rows: [
                  { label: "Share", value: fmtPct(as.share * 100), tone: as.tone },
                  { label: valueLabel, value: format(as.value) },
                ] } : null} />
      <ul className="ring__legend">
        {shares.map((s) => (
          <li key={s.key}>
            <i className={`ring__swatch ring__swatch--${s.tone}`} aria-hidden />
            <span className="ring__legend-label">{s.label}</span>
            <span className="ring__legend-pct">{total > 0 ? fmtPct(s.share * 100) : "-"}</span>
            <span className="ring__legend-amount">{format(s.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
