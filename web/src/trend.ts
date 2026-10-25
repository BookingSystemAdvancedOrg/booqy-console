/** How a figure is doing: one rule for whether a number on the Finance page
 * is green (better than the comparison), red (worse) or neutral. The same
 * rule as admin-front-end/src/shared/trend.ts. Neutral when there is
 * nothing to compare with, when the figure stands at zero (the period has
 * just started, no nightly figures yet) or when the change is so small it
 * is noise.
 *
 * Every metric knows which way is good: more revenue is good, a smaller
 * AWS cost is good. Colour never stands alone: the text ("+12 %") and the
 * screen reader text ("up 12 % vs previous period") say the same thing. */

export type TrendTone = "good" | "bad" | "neutral";

export type TrendMetric =
  | "revenue"
  | "margin"
  | "mrr"
  | "cost"
  | "unitCost"
  | "sms"
  | "customers"
  | "arpu"
  | "visits"
  | "conversions"
  | "rate"
  | "bounce"
  | "seconds";

interface MetricRule {
  /** Which way the figure should go to be good. */
  better: "up" | "down";
  /** Smallest change in percent that counts (anything smaller is noise). */
  minPct: number;
  /** Smallest change in the metric's unit (SEK or count). */
  minAbs: number;
  /** Show the change as a percentage or as a difference ("+2"). */
  show: "pct" | "abs";
}

const RULES: Record<TrendMetric, MetricRule> = {
  revenue: { better: "up", minPct: 2, minAbs: 100, show: "pct" },
  margin: { better: "up", minPct: 2, minAbs: 100, show: "pct" },
  mrr: { better: "up", minPct: 1, minAbs: 50, show: "pct" },
  cost: { better: "down", minPct: 2, minAbs: 10, show: "pct" },
  unitCost: { better: "down", minPct: 3, minAbs: 0.05, show: "pct" },
  sms: { better: "up", minPct: 2, minAbs: 10, show: "pct" },
  customers: { better: "up", minPct: 0, minAbs: 1, show: "abs" },
  arpu: { better: "up", minPct: 2, minAbs: 5, show: "pct" },
  // Website page: visitors, visits, page views; demo bookings; conversion rate and bounce rate in percent points.
  visits: { better: "up", minPct: 3, minAbs: 5, show: "pct" },
  conversions: { better: "up", minPct: 0, minAbs: 1, show: "abs" },
  rate: { better: "up", minPct: 3, minAbs: 0.2, show: "pct" },
  bounce: { better: "down", minPct: 3, minAbs: 1, show: "pct" },
  seconds: { better: "up", minPct: 5, minAbs: 3, show: "pct" },
};

export interface Trend {
  tone: TrendTone;
  /** Which way the figure went; null when it could not be compared. */
  direction: "up" | "down" | "flat" | null;
  /** What stands next to the figure: "+12 %", "-3", "unchanged", "new" or "". */
  text: string;
  /** The whole sentence for screen readers: "up 12 % vs previous period". */
  spoken: string;
}

export const NO_TREND: Trend = { tone: "neutral", direction: null, text: "", spoken: "" };

function fmtNumber(n: number, digits: number): string {
  return n.toLocaleString("sv-SE", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** "12 %", "4,5 %": one decimal under ten. */
function fmtPercent(n: number): string {
  return `${fmtNumber(n, n < 10 ? 1 : 0)} %`;
}

/** The tone of a figure against the comparison. `against` is what it is
 * compared with, as it reads after "vs" ("previous period"). Without a
 * comparison (null), at zero or with too small a change it is neutral. */
export function trendOf(
  current: number | null | undefined,
  previous: number | null | undefined,
  metric: TrendMetric,
  against: string,
): Trend {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return NO_TREND;
  const rule = RULES[metric];
  const versus = against ? ` vs ${against}` : "";
  // Zero is a fresh start (no figures yet), not a grade. But zero of something bad (no cost) against last time is progress.
  if (current === 0 && (previous === 0 || rule.better === "up")) return NO_TREND;
  // From nothing to something: revenue where there was none is progress, cost where there was none is not.
  if (previous === 0) {
    const tone: TrendTone = Math.abs(current) < rule.minAbs ? "neutral" : (current > 0) === (rule.better === "up") ? "good" : "bad";
    const direction = current > 0 ? "up" : "down";
    return { tone, direction, text: "new", spoken: `${direction} from zero${versus}` };
  }

  const diff = current - previous;
  const pct = (diff / Math.abs(previous)) * 100;
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const counts = direction !== "flat" && Math.abs(diff) >= rule.minAbs && Math.abs(pct) >= rule.minPct;
  const tone: TrendTone = !counts ? "neutral" : (direction === "up") === (rule.better === "up") ? "good" : "bad";

  const amount = rule.show === "abs" ? fmtNumber(Math.abs(diff), 1) : fmtPercent(Math.abs(pct));
  if (direction === "flat" || amount === fmtPercent(0) || amount === "0") {
    return { tone: "neutral", direction: "flat", text: "unchanged", spoken: `unchanged${versus}` };
  }
  const sign = direction === "up" ? "+" : "-";
  return { tone, direction, text: `${sign}${amount}`, spoken: `${direction} ${amount}${versus}` };
}

/** The class that colours the figure itself: green, red or the normal print. */
export function toneClass(tone: TrendTone): string {
  return tone === "neutral" ? "" : ` trend-value--${tone}`;
}
