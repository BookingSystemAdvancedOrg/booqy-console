/** Date ranges, number formatting and the small maths behind the Finance
 * page. Pure functions: tested in finance.test.ts. */
import type { FinancePoint, FinanceTenantRow } from "./types";

export type Preset = "week" | "month" | "quarter" | "year" | "last30" | "custom";

export const PRESETS: { id: Preset; label: string }[] = [
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "quarter", label: "This quarter" },
  { id: "year", label: "This year" },
  { id: "last30", label: "Last 30 days" },
  { id: "custom", label: "Custom" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** yyyy-mm-dd in local time (the operator's calendar, not UTC). */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(iso: string, n: number): string {
  const d = parseDay(iso);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

/** The from/to of a preset, ending today (periods in progress are open-ended). */
export function presetRange(preset: Preset, today = new Date()): { from: string; to: string } {
  const to = isoDay(today);
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (preset) {
    case "week": {
      const day = (today.getDay() + 6) % 7; // Monday = 0
      return { from: addDays(to, -day), to };
    }
    case "month":
      return { from: isoDay(new Date(y, m, 1)), to };
    case "quarter":
      return { from: isoDay(new Date(y, m - (m % 3), 1)), to };
    case "year":
      return { from: `${y}-01-01`, to };
    case "last30":
      return { from: addDays(to, -29), to };
    default:
      return { from: addDays(to, -29), to };
  }
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000) + 1;
}

// --- formatting (sv-SE: space thousands, comma decimals, "kr") ---------------------
const sek0 = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 0 });
const sek2 = new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("sv-SE");

export function fmtSek(value: number | null | undefined, opts: { decimals?: boolean } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  const n = Number(value);
  return `${(opts.decimals || (Math.abs(n) < 100 && n !== 0) ? sek2 : sek0).format(n)} kr`;
}

export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return int.format(Number(value));
}

export function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 }).format(Number(value))}\u00a0%`;
}

export function fmtDay(iso: string | undefined | null): string {
  if (!iso) return "-";
  return parseDay(iso.slice(0, 10)).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

/** Short axis label: "ma 3 okt" style is too long; day-of-month or week start. */
export function shortDay(iso: string): string {
  return parseDay(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }).replace(".", "");
}

// --- series --------------------------------------------------------------------------
export type Grain = "day" | "week" | "month";

/** Day rows are summed into weeks or months when the range is long, so a
 * chart never has hundreds of bars. */
export function grainFor(days: number): Grain {
  if (days <= 31) return "day";
  if (days <= 190) return "week";
  return "month";
}

export function bucketKey(day: string, grain: Grain): string {
  if (grain === "day") return day;
  if (grain === "month") return `${day.slice(0, 7)}-01`;
  const d = parseDay(day);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return isoDay(d);
}

export interface Bucket {
  key: string;
  revenue: number;
  collected: number;
  cost: number;
  mrr: number;
  bookings: number;
  orders: number;
}

export function bucketSeries(series: FinancePoint[], grain: Grain): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const p of series) {
    const key = bucketKey(p.day, grain);
    const b = map.get(key) ?? { key, revenue: 0, collected: 0, cost: 0, mrr: 0, bookings: 0, orders: 0 };
    b.revenue += Number(p.invoicedSek) || 0;
    b.collected += Number(p.paidSek) || 0;
    b.cost += Number(p.costSek) || 0;
    b.mrr = Number(p.mrrSek) || 0;            // a snapshot: the last day of the bucket wins
    b.bookings += Number(p.bookings) || 0;
    b.orders += Number(p.orders) || 0;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function topAndBottom<T extends { marginSek: number }>(rows: T[], n: number): { top: T[]; bottom: T[] } {
  const sorted = [...rows].sort((a, b) => b.marginSek - a.marginSek);
  if (sorted.length <= n * 2) return { top: sorted, bottom: [] };
  return { top: sorted.slice(0, n), bottom: sorted.slice(-n).reverse() };
}

export type SortKey = keyof Pick<FinanceTenantRow,
  "name" | "marginSek" | "marginPct" | "revenueSek" | "collectedSek" | "outstandingSek" | "costSek" | "mrrSek" | "bookings" | "orders" | "requests">;

export function sortRows(rows: FinanceTenantRow[], key: SortKey, dir: "asc" | "desc"): FinanceTenantRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === "string" || typeof vb === "string") return sign * String(va ?? "").localeCompare(String(vb ?? ""), "sv");
    return sign * ((Number(va) || 0) - (Number(vb) || 0));
  });
}

/** Customer filter: name, legal name, org number (with or without dash) or slug. */
export function matchesCustomer(row: { name?: string; legalName?: string; orgNumber?: string; slug?: string }, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  return [row.name, row.legalName, row.slug].some((s) => s?.toLowerCase().includes(q))
    || (!!digits && !!row.orgNumber && row.orgNumber.replace(/\D/g, "").includes(digits));
}
