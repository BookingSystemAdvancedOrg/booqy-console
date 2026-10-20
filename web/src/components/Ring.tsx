/** A ring (donut) that shares a total between a few segments, drawn on a
 * spring so the arcs grow in, with the hero share in the middle and a
 * legend that states every share, so colour is never the only signal. */
import { useId } from "react";
import { fmtPct, fmtSek } from "../finance";
import { useSpring } from "./motion";

export type RingTone = "ink" | "red" | "warn" | "ok" | "steel";
export interface RingSegment { key: string; label: string; value: number; tone: RingTone }

const SIZE = 150;
const R = 58;
const C = 2 * Math.PI * R;

export function Ring({ title, segments, total, centerLabel, empty, format = fmtSek }: {
  title: string;
  segments: RingSegment[];
  /** The whole the shares are of; segments beyond it are clipped. */
  total: number;
  centerLabel: string;
  /** Shown when there is nothing to share. */
  empty: string;
  format?: (n: number) => string;
}) {
  const id = useId();
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
  return (
    <figure className="ring" aria-labelledby={`${id}-t`}>
      <figcaption className="ring__title" id={`${id}-t`}>{title}</figcaption>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="ring__svg" role="img" aria-label={`${title}: ${shares.map((s) => `${s.label} ${fmtPct(s.share * 100)}`).join(", ")}`}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} className="ring__track" />
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {arcs.map((a) => (
            <circle key={a.key} cx={SIZE / 2} cy={SIZE / 2} r={R} className={`ring__seg ring__seg--${a.tone}`}
                    strokeDasharray={a.dash} strokeDashoffset={a.offset} />
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
