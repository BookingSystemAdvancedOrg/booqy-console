import type { FreeInput } from "./types";

export const FREE_PLAN_ID = "free";
export const FREE_MONTHS = 3;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today in Europe/Stockholm as yyyy-mm-dd. */
export function stockholmToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
}

/** yyyy-mm-dd plus whole months, the day clamped to the month's last (31 Jan + 1 = 28/29 Feb). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** yyyy-mm-dd plus (or minus) whole days. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The last free day of `months` months from today (Stockholm): from 14 Nov, 3 months end on 13 Feb, so the first paid day is 14 Feb. */
export function freeUntilAfter(months: number, now: Date = new Date()): string {
  return addDays(addMonths(stockholmToday(now), months), -1);
}

/** The default last free day: three months from today (Stockholm). */
export function defaultFreeUntil(now: Date = new Date()): string {
  return freeUntilAfter(FREE_MONTHS, now);
}

/** The owner is told this many days before the first paid day. */
export const FREE_NOTICE_DAYS = 14;

/** The earliest new last free day: 14 days ahead, so the owner is told in time. */
export function earliestFreeUntil(now: Date = new Date()): string {
  const [y, m, d] = stockholmToday(now).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + FREE_NOTICE_DAYS)).toISOString().slice(0, 10);
}

/** "14 Feb 2027" (the date as written, no time zone shift). */
export function fmtFreeDay(day: string): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The badge text: "Free until 14 Feb 2027" or "Free". */
export function freeLabel(until: string | null | undefined): string {
  return until ? `Free until ${fmtFreeDay(until)}` : "Free";
}

/** The Free plan's three options: free until an operator changes it, or 3 / 6 months then a paid plan. */
export type FreePreset = "until_changed" | "3m" | "6m";

export const FREE_OPTIONS: { id: FreePreset; label: string; sub: string }[] = [
  { id: "until_changed", label: "Free until changed", sub: "No end" },
  { id: "3m", label: "Free for 3 months", sub: "Then a paid plan" },
  { id: "6m", label: "Free for 6 months", sub: "Then a paid plan" },
];

const PRESET_MONTHS: Record<FreePreset, number | null> = { until_changed: null, "3m": 3, "6m": 6 };

/** The last free day of a preset from its first day (the backend computes the same): the day before the same date 3 or 6 months on. */
export function presetUntil(preset: FreePreset, start: string): string | null {
  const months = PRESET_MONTHS[preset];
  return months === null ? null : addDays(addMonths(start, months), -1);
}

/** The form's state for the Free plan's period. preset null = an older
 * customer's own end date (`keptUntil`), kept as it is until a preset is picked. */
export interface FreeForm {
  preset: FreePreset | null;
  thenPlanId: string;
  keptUntil?: string | null;
}

/** A new Free period: 3 months, the plan after it still to pick. */
export function newFreeForm(): FreeForm {
  return { preset: "3m", thenPlanId: "" };
}

/** A saved Free period as the form: its preset, or one read from the dates of an older customer. */
export function savedFreeForm(billing: { freeUntil?: string | null; freeThenPlanId?: string | null; freePreset?: string | null; freeSince?: string | null } | undefined): FreeForm {
  const until = billing?.freeUntil ?? null;
  const then = billing?.freeThenPlanId ?? "";
  const stored = billing?.freePreset;
  if (stored === "until_changed" || stored === "3m" || stored === "6m") return { preset: stored, thenPlanId: then, keptUntil: until };
  if (!until) return { preset: "until_changed", thenPlanId: then };
  const since = billing?.freeSince;
  const match = since ? (["3m", "6m"] as const).find((p) => presetUntil(p, since) === until) : undefined;
  return { preset: match ?? null, thenPlanId: then, keptUntil: until };
}

/** The last free day the form shows: the saved one while the preset is unchanged, else computed from `start`. */
export function formUntil(form: FreeForm, start: string, saved?: FreeForm | null): string | null {
  if (form.preset === null) return form.keptUntil ?? null;
  if (saved && saved.preset === form.preset && saved.keptUntil !== undefined) return saved.keptUntil ?? null;
  return presetUntil(form.preset, start);
}

/** Has an end, so the plan and price after it are needed. */
export const isTimed = (form: FreeForm) => form.preset !== "until_changed";

/** What stops a Free period from being saved: the plan and a price above 0 after a timed one. */
export function freeProblems(form: FreeForm, price: string): { thenPlanId?: string; price?: string } {
  if (!isTimed(form)) return {};
  const out: { thenPlanId?: string; price?: string } = {};
  if (!form.thenPlanId) out.thenPlanId = "Pick the plan after Free";
  if (!(Number(price) > 0)) out.price = "Set the monthly price after Free";
  return out;
}

/** What the API gets: the preset (the end computed there), or an older customer's date as it is. */
export function freeInput(form: FreeForm): FreeInput {
  if (form.preset === null) return { until: form.keptUntil ?? null, thenPlanId: form.thenPlanId || "starter" };
  return form.preset === "until_changed" ? { preset: "until_changed" } : { preset: form.preset, thenPlanId: form.thenPlanId };
}
