/** Types, ranges, labels and the CSV export behind the Website page
 * (booqy.se's cookieless statistics). Pure functions: tested in website.test.ts. */
import { addDays, isoDay, previousRange } from "./finance";

export interface WebsiteKpis {
  visitors: number;
  visits: number;
  pageviews: number;
  conversions: number;
  convertedVisits: number;
  conversionRate: number | null;
  bounceRate: number | null;
  avgEngagedSeconds: number | null;
  pagesPerVisit: number | null;
}

export interface VisitRow { key: string; visits: number; conversions: number; bounces: number; }
export interface PageRow { key: string; pageviews: number; avgSeconds: number | null; }

export interface WebsiteOverview {
  enabled: boolean;
  period: { from: string; to: string; days: number };
  previous: { from: string; to: string };
  asOf: string | null;
  live: { minutes: number; visitors: number } | null;
  kpis: WebsiteKpis;
  previousKpis: WebsiteKpis | null;
  series: { day: string; visitors: number; visits: number; pageviews: number; conversions: number }[];
  hours: number[];
  scroll: Record<"0" | "25" | "50" | "75" | "100", number>;
  events: { cta?: { key: string; count: number }[]; tab?: { key: string; count: number }[] };
  breakdowns: {
    sources: VisitRow[]; referrers: VisitRow[]; campaigns: VisitRow[]; contents: VisitRow[]; terms: VisitRow[];
    landing: VisitRow[]; pages: PageRow[]; countries: VisitRow[]; regions: VisitRow[]; cities: VisitRow[];
    devices: VisitRow[]; browsers: VisitRow[]; os: VisitRow[]; languages: VisitRow[];
  };
  previousSources: Record<string, VisitRow>;
}

export type Preset = 7 | 30 | 90 | "custom";

export const PRESETS: { id: Preset; label: string }[] = [
  { id: 7, label: "7 days" },
  { id: 30, label: "30 days" },
  { id: 90, label: "90 days" },
  { id: "custom", label: "Custom" },
];

/** The last `days` days, today included. */
export function lastDays(days: number, today = new Date()): { from: string; to: string } {
  const to = isoDay(today);
  return { from: addDays(to, -(days - 1)), to };
}

export { previousRange };

export const SOURCE_LABEL: Record<string, string> = {
  direct: "Direct", search: "Search", social: "Social", referral: "Referral", campaign: "Campaigns (UTM)",
};
export const SOURCE_HINT: Record<string, string> = {
  direct: "Typed the address, a bookmark or an app that sends no referrer",
  search: "Google, Bing, DuckDuckGo and other search engines",
  social: "Facebook, Instagram, LinkedIn, X, TikTok and other social sites",
  referral: "A link on another website",
  campaign: "A link tagged with utm_source, utm_medium or utm_campaign",
};

/** "facebook|paid|host" as its three parts ("-" where a tag is missing). */
export function campaignParts(key: string): { source: string; medium: string; campaign: string } {
  const [source = "", medium = "", campaign = ""] = key.split("|");
  return { source: source || "-", medium: medium || "-", campaign: campaign || "-" };
}

/** "SE|Stockholms län" as place and country. */
export function placeParts(key: string): { country: string; place: string } {
  const i = key.indexOf("|");
  return i < 0 ? { country: key, place: key } : { country: key.slice(0, i), place: key.slice(i + 1) };
}

const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

/** "SE" as "Sweden". */
export function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Seconds as "1 min 05 s" or "42 s". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "-";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** part as a share of whole, or null when there is nothing to share. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

/** Scroll depth: the share of read pages that reached at least each band. */
export function scrollReach(scroll: WebsiteOverview["scroll"]): { band: string; pct: number | null }[] {
  const bands = ["25", "50", "75", "100"] as const;
  const total = Object.values(scroll).reduce((a, b) => a + b, 0);
  return bands.map((band) => {
    const reached = (["25", "50", "75", "100"] as const).filter((b) => Number(b) >= Number(band)).reduce((a, b) => a + scroll[b], 0);
    return { band, pct: share(reached, total) };
  });
}

/* --- CSV export (the Finance format: semicolons, decimal commas, BOM for Swedish Excel) --- */
const csvNumber = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(Number(v)) ? "" : Number(v).toLocaleString("sv-SE", { maximumFractionDigits: digits, useGrouping: false });
const csvEscape = (c: string) => (/[;"\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
const toCsvText = (rows: string[][]) => "﻿" + rows.map((r) => r.map(csvEscape).join(";")).join("\r\n") + "\r\n";

/** One row per day. */
export function dailyCsv(data: WebsiteOverview): string {
  const head = ["Day", "Visitors", "Visits", "Page views", "Demo bookings"];
  return toCsvText([head, ...data.series.map((p) => [p.day, csvNumber(p.visitors, 0), csvNumber(p.visits, 0),
    csvNumber(p.pageviews, 0), csvNumber(p.conversions, 0)])]);
}

const BREAKDOWN_NAME: Record<string, string> = {
  sources: "Source", referrers: "Referrer", campaigns: "Campaign (source|medium|campaign)", contents: "UTM content",
  terms: "UTM term", landing: "Landing page", pages: "Page", countries: "Country", regions: "Region", cities: "City",
  devices: "Device", browsers: "Browser", os: "Operating system", languages: "Language",
};

/** Every breakdown as one long table: kind, key, visits, demo bookings, conversion and bounce rate (pages: views, time). */
export function breakdownsCsv(data: WebsiteOverview): string {
  const head = ["Breakdown", "Value", "Visits", "Demo bookings", "Conversion %", "Bounce %", "Page views", "Avg engaged s"];
  const rows: string[][] = [];
  for (const [kind, list] of Object.entries(data.breakdowns)) {
    for (const r of list as (VisitRow | PageRow)[]) {
      if ("pageviews" in r) rows.push([BREAKDOWN_NAME[kind] ?? kind, r.key, "", "", "", "", csvNumber(r.pageviews, 0), csvNumber(r.avgSeconds, 0)]);
      else rows.push([BREAKDOWN_NAME[kind] ?? kind, r.key, csvNumber(r.visits, 0), csvNumber(r.conversions, 0),
        csvNumber(share(r.conversions, r.visits), 1), csvNumber(share(r.bounces, r.visits), 1), "", ""]);
    }
  }
  return toCsvText([head, ...rows]);
}

export function csvName(kind: "daily" | "breakdowns", period: { from: string; to: string }): string {
  return `booqy-website-${kind}-${period.from}-${period.to}.csv`;
}
