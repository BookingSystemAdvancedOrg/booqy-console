/** Date ranges, number formatting and the small maths behind the Finance
 * page. Pure functions: tested in finance.test.ts. */
import type { FinancePoint, FinanceTenantRow } from "./types";

/** How many billing periods the Finance page shows, ending with the picked one. */
export type Span = 1 | 3 | 12;

export const SPANS: { id: Span; label: string }[] = [
  { id: 1, label: "Period" },
  { id: 3, label: "3 periods" },
  { id: 12, label: "12 periods" },
];

/** Billing periods run from the 25th to the 24th (the invoice of a period is made on the next 25th). */
export const PERIOD_START_DAY = 25;

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

/** A billing period as a from/to range (periodOf, below, gives start/end). */
function rangeOf(day: string): { from: string; to: string } {
  const p = periodOf(day);
  return { from: p.start, to: p.end };
}

/** The period `n` periods before the one starting on `from` (n = 1: the previous one). */
export function periodBefore(from: string, n = 1): { from: string; to: string } {
  const d = parseDay(from);
  return rangeOf(isoDay(new Date(d.getFullYear(), d.getMonth() - n, PERIOD_START_DAY)));
}

/** The billing periods to pick from, newest first: the current one and `count - 1` before it. */
export function periodChoices(count = 24, today = new Date()): { from: string; to: string; current: boolean }[] {
  const current = rangeOf(isoDay(today));
  return Array.from({ length: count }, (_, i) => ({ ...(i ? periodBefore(current.from, i) : current), current: i === 0 }));
}

/** Label for the period dropdown: "25 sep. to 24 okt. 2026". */
export function periodLabel(p: { from: string; to: string }): string {
  return `${fmtDay(p.from)} to ${fmtDay(p.to)} ${p.to.slice(0, 4)}`;
}

/** The range shown: `span` periods ending with the picked one, cut at today (a period in progress shows up to today). */
export function spanRange(periodFrom: string, span: Span, today = new Date()): { from: string; to: string } {
  const last = rangeOf(periodFrom);
  const first = span > 1 ? periodBefore(last.from, span - 1) : last;
  const t = isoDay(today);
  return { from: first.from, to: last.to < t ? last.to : t };
}

/** The comparison range: the same number of periods before, cut at the same number of days, so a
 * period in progress is compared with the same days of the period before it. */
export function previousSpanRange(range: { from: string; to: string }, span: Span): { from: string; to: string } {
  const from = periodBefore(range.from, span).from;
  return { from, to: addDays(from, daysBetween(range.from, range.to) - 1) };
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
  "name" | "marginSek" | "marginPct" | "revenueSek" | "collectedSek" | "outstandingSek" | "costSek" | "mrrSek" | "bookings" | "orders" | "requests" | "smsParts" | "smsRevenueSek">;

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

/** First and last day of a yyyy-mm month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  return { from: isoDay(new Date(y, m - 1, 1)), to: isoDay(new Date(y, m, 0)) };
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const text = new Date(y, m - 1, 1).toLocaleDateString("sv-SE", { month: "long", year: "numeric" });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The period of the same length right before from..to. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const n = daysBetween(from, to);
  return { from: addDays(from, -n), to: addDays(from, -1) };
}

/** AWS cost summed per allocation bucket over the customer rows. */
export function costSplitTotals(rows: { costSplitSek: { baseline: number; requests: number; email: number; sms: number } }[]) {
  const out = { requests: 0, baseline: 0, email: 0, sms: 0 };
  for (const r of rows) {
    for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] += Number(r.costSplitSek?.[k]) || 0;
  }
  return out;
}

/** "Revenue 12 % up" style insight for a card title. */
export function insightTitle(base: string, pct: number | null, up = "up", down = "down"): string {
  if (pct === null || !Number.isFinite(pct)) return base;
  if (Math.abs(pct) < 0.05) return `${base}: unchanged`;
  return `${base}: ${fmtPct(Math.abs(pct))} ${pct > 0 ? up : down}`;
}

/** The same day `n` months later (clamped to the month's last day), as yyyy-mm-dd. */
export function addMonths(iso: string, n: number): string {
  const d = parseDay(iso.slice(0, 10));
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return isoDay(target);
}

// --- billing periods: the 25th to the 24th ------------------------------------------
const SV_MONTHS = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];

/** The period a day falls in: from the 25th to the 24th. */
export function periodOf(iso: string): { start: string; end: string } {
  const d = parseDay(iso.slice(0, 10));
  const start = d.getDate() >= 25 ? new Date(d.getFullYear(), d.getMonth(), 25) : new Date(d.getFullYear(), d.getMonth() - 1, 25);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 24);
  return { start: isoDay(start), end: isoDay(end) };
}

export function nextPeriod(endIso: string): { start: string; end: string } {
  return periodOf(addDays(endIso, 1));
}

export function periodText(startIso: string, endIso: string): string {
  const a = parseDay(startIso), b = parseDay(endIso);
  return `${a.getDate()} ${SV_MONTHS[a.getMonth()]} till ${b.getDate()} ${SV_MONTHS[b.getMonth()]} ${b.getFullYear()}`;
}

/** When a cancellation takes effect: a try-out with the current period, a subscription `noticeMonths` periods later. */
export function endDateFor(terms: "trial" | "subscription", noticeMonths: number, today = isoDay(new Date())): string {
  let { end } = periodOf(today);
  if (terms === "trial") return end;
  for (let i = 0; i < noticeMonths; i++) end = nextPeriod(end).end;
  return end;
}

/* --- CSV export (same format as the restaurant admin's Statistik export) --- */

/** Semicolon separated with decimal commas and a BOM, which Swedish Excel opens directly. */
const csvNumber = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(Number(v)) ? "" : Number(v).toLocaleString("sv-SE", { maximumFractionDigits: digits, useGrouping: false });
const csvEscape = (c: string) => (/[;"\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
const toCsvText = (rows: string[][]) => "﻿" + rows.map((r) => r.map(csvEscape).join(";")).join("\r\n") + "\r\n";

/** One row per customer for the chosen period, amounts in SEK excluding VAT. */
export function customersCsv(rows: FinanceTenantRow[]): string {
  const head = ["Customer", "Legal name", "Org number", "Status", "Billing", "MRR SEK", "Revenue SEK", "Collected SEK", "Credited SEK",
    "Outstanding SEK", "Cost SEK", "Cost baseline SEK", "Cost requests SEK", "Cost email SEK", "Cost SMS SEK", "Margin SEK", "Margin %",
    "Bookings", "Orders", "Requests", "Emails", "Marketing emails", "SMS", "SMS parts", "SMS revenue SEK", "SMS cost SEK", "SMS margin SEK",
    "Cost per booking SEK", "Cost per order SEK", "Active days", "Invoices"];
  const body = rows.map((t) => [t.name, t.legalName ?? "", t.orgNumber ?? "", t.status, t.billingStatus, csvNumber(t.mrrSek), csvNumber(t.revenueSek),
    csvNumber(t.collectedSek), csvNumber(t.creditedSek), csvNumber(t.outstandingSek), csvNumber(t.costSek), csvNumber(t.costSplitSek?.baseline),
    csvNumber(t.costSplitSek?.requests), csvNumber(t.costSplitSek?.email), csvNumber(t.costSplitSek?.sms), csvNumber(t.marginSek),
    csvNumber(t.marginPct, 1), csvNumber(t.bookings, 0), csvNumber(t.orders, 0), csvNumber(t.requests, 0), csvNumber(t.emails, 0),
    csvNumber(t.marketingEmails, 0), csvNumber(t.sms, 0), csvNumber(t.smsParts, 0), csvNumber(t.smsRevenueSek), csvNumber(t.smsCostSek),
    csvNumber(t.smsMarginSek), csvNumber(t.costPerBookingSek), csvNumber(t.costPerOrderSek), csvNumber(t.activeDays, 0), csvNumber(t.invoiceCount, 0)]);
  return toCsvText([head, ...body]);
}

/** One row per day for the chosen period (the chart data). */
export function dailyCsv(series: FinancePoint[]): string {
  const head = ["Day", "Invoiced SEK", "Paid SEK", "Cost SEK", "MRR SEK", "Bookings", "Orders", "Requests", "Active customers", "SMS parts", "SMS revenue SEK"];
  const body = series.map((p) => [p.day, csvNumber(p.invoicedSek), csvNumber(p.paidSek), csvNumber(p.costSek), csvNumber(p.mrrSek),
    csvNumber(p.bookings, 0), csvNumber(p.orders, 0), csvNumber(p.requests, 0), csvNumber(p.activeTenants, 0), csvNumber(p.smsParts, 0),
    csvNumber(p.smsRevenueSek)]);
  return toCsvText([head, ...body]);
}

export function csvName(kind: "customers" | "daily", period: { from: string; to: string }): string {
  return `booqy-finance-${kind}-${period.from}-${period.to}.csv`;
}
