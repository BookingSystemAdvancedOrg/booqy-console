/** Small SVG charts in the console's print style: no dependency, print-black
 * ink on paper, the wine red for cost. Every chart scales with its ticket
 * (viewBox + width 100%) and names its values for screen readers. */
import { useEffect, useId, useRef, useState } from "react";
import { fmtSek, shortDay } from "../finance";

const H = 220;
const PAD = { top: 14, right: 12, bottom: 30, left: 56 };

/** The chart is drawn at its ticket's real width, so labels keep their
 * size on a phone instead of being scaled down with the picture. */
function useWidth(fallback = 640): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(Math.max(280, Math.round(el.getBoundingClientRect().width) || fallback));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function tickLabel(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} mkr`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} tkr`;
  return `${v.toLocaleString("sv-SE", { maximumFractionDigits: 0 })} kr`;
}

export interface BarLinePoint { key: string; bar: number; line: number; }

/** Bars (revenue) with a line (cost) over the same buckets. */
export function BarLineChart({ points, barLabel, lineLabel, ariaLabel }: {
  points: BarLinePoint[]; barLabel: string; lineLabel: string; ariaLabel: string;
}) {
  const id = useId();
  const [ref, W] = useWidth();
  if (points.length === 0) return <ChartEmpty />;
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.bar, p.line)), 1));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / points.length;
  const barW = Math.max(3, Math.min(28, slot * 0.6));
  const y = (v: number) => PAD.top + innerH - (Math.max(0, v) / max) * innerH;
  const x = (i: number) => PAD.left + slot * i + slot / 2;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.ceil(points.length / Math.max(3, Math.floor(innerW / 80)));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.line).toFixed(1)}`).join(" ");
  return (
    <figure className="chart" ref={ref as React.RefObject<HTMLElement>}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-labelledby={`${id}-t`} className="chart__svg">
        <title id={`${id}-t`}>{ariaLabel}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="chart__grid" />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="chart__tick">{tickLabel(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (
          <g key={p.key}>
            <rect x={x(i) - barW / 2} y={y(p.bar)} width={barW} height={Math.max(0, PAD.top + innerH - y(p.bar))} className="chart__bar">
              <title>{`${shortDay(p.key)}: ${barLabel} ${fmtSek(p.bar)}, ${lineLabel} ${fmtSek(p.line)}`}</title>
            </rect>
            {i % labelEvery === 0 && (
              <text x={x(i)} y={H - 10} textAnchor="middle" className="chart__tick">{shortDay(p.key)}</text>
            )}
          </g>
        ))}
        <path d={line} className="chart__line" />
        {points.map((p, i) => <circle key={p.key} cx={x(i)} cy={y(p.line)} r={2.6} className="chart__dot" />)}
      </svg>
      <figcaption className="legend">
        <span><i className="legend__bar" />{barLabel}</span>
        <span><i className="legend__line" />{lineLabel}</span>
      </figcaption>
    </figure>
  );
}

/** A single line (MRR over time), filled underneath. */
export function LineChart({ points, label, ariaLabel }: { points: { key: string; value: number }[]; label: string; ariaLabel: string }) {
  const id = useId();
  const [ref, W] = useWidth();
  if (points.length === 0) return <ChartEmpty />;
  const max = niceMax(Math.max(...points.map((p) => p.value), 1));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => (points.length === 1 ? PAD.left + innerW / 2 : PAD.left + (innerW * i) / (points.length - 1));
  const y = (v: number) => PAD.top + innerH - (Math.max(0, v) / max) * innerH;
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${path} L${x(points.length - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`;
  const labelEvery = Math.ceil(points.length / Math.max(3, Math.floor(innerW / 90)));
  return (
    <figure className="chart" ref={ref as React.RefObject<HTMLElement>}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-labelledby={`${id}-t`} className="chart__svg">
        <title id={`${id}-t`}>{ariaLabel}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="chart__grid" />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="chart__tick">{tickLabel(t)}</text>
          </g>
        ))}
        <path d={area} className="chart__area" />
        <path d={path} className="chart__line chart__line--ink" />
        {points.map((p, i) => (
          <g key={p.key}>
            <circle cx={x(i)} cy={y(p.value)} r={2.6} className="chart__dot chart__dot--ink"><title>{`${shortDay(p.key)}: ${label} ${fmtSek(p.value)}`}</title></circle>
            {i % labelEvery === 0 && <text x={x(i)} y={H - 10} textAnchor="middle" className="chart__tick">{shortDay(p.key)}</text>}
          </g>
        ))}
      </svg>
      <figcaption className="legend"><span><i className="legend__line legend__line--ink" />{label}</span></figcaption>
    </figure>
  );
}

/** Horizontal bars, one per customer, negative values to the left. */
export function HBarChart({ rows, ariaLabel }: { rows: { key: string; label: string; value: number; href?: string }[]; ariaLabel: string }) {
  const id = useId();
  const [ref, W] = useWidth();
  if (rows.length === 0) return <ChartEmpty />;
  const max = niceMax(Math.max(...rows.map((r) => Math.abs(r.value)), 1));
  const rowH = 28;
  const labelW = Math.min(150, Math.round(W * 0.34));
  const h = rows.length * rowH + 8;
  const innerW = W - labelW - 90;
  const zero = labelW + (rows.some((r) => r.value < 0) ? innerW / 2 : 0);
  const scale = rows.some((r) => r.value < 0) ? innerW / 2 / max : innerW / max;
  return (
    <figure className="chart chart--hbar" ref={ref as React.RefObject<HTMLElement>}>
      <svg viewBox={`0 0 ${W} ${h}`} width={W} height={h} role="img" aria-labelledby={`${id}-t`} className="chart__svg">
        <title id={`${id}-t`}>{ariaLabel}</title>
        <line x1={zero} x2={zero} y1={0} y2={h} className="chart__axis" />
        {rows.map((r, i) => {
          const y = 4 + i * rowH;
          const w = Math.abs(r.value) * scale;
          const x = r.value < 0 ? zero - w : zero;
          return (
            <g key={r.key}>
              <text x={labelW - 10} y={y + 17} textAnchor="end" className="chart__label">{r.label.length > labelW / 7 ? `${r.label.slice(0, Math.floor(labelW / 7) - 1)}…` : r.label}</text>
              <rect x={x} y={y + 4} width={Math.max(1, w)} height={rowH - 10} className={r.value < 0 ? "chart__bar chart__bar--neg" : "chart__bar"}>
                <title>{`${r.label}: ${fmtSek(r.value)}`}</title>
              </rect>
              <text x={r.value < 0 ? x - 6 : x + w + 6} y={y + 17} textAnchor={r.value < 0 ? "end" : "start"} className="chart__value">{fmtSek(r.value)}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function ChartEmpty() {
  return <p className="chart__empty">Nothing to draw yet.</p>;
}
