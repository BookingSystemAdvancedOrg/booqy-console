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

/** The form's state for the Free plan's period. */
export interface FreeForm {
  until: string;
  noEnd: boolean;
  thenPlanId: string;
}

export function freeForm(until?: string | null, thenPlanId?: string | null, now: Date = new Date()): FreeForm {
  return { until: until ?? defaultFreeUntil(now), noEnd: until === null, thenPlanId: thenPlanId || "starter" };
}

export function freeInput(form: FreeForm): FreeInput {
  return { until: form.noEnd ? null : form.until, thenPlanId: form.thenPlanId };
}

/** The presets of the Free period: three or six months from today, no end date, or a date of your own. */
export type FreePreset = "3m" | "6m" | "none" | "custom";

export const FREE_PRESETS: { id: FreePreset; label: string }[] = [
  { id: "3m", label: "3 months" },
  { id: "6m", label: "6 months" },
  { id: "none", label: "No end date" },
  { id: "custom", label: "Custom" },
];

/** The form after picking a preset (custom keeps the date and opens the date field). */
export function applyFreePreset(form: FreeForm, preset: FreePreset, now: Date = new Date()): FreeForm {
  if (preset === "none") return { ...form, noEnd: true, until: form.until || defaultFreeUntil(now) };
  if (preset === "custom") return { ...form, noEnd: false, until: form.until || defaultFreeUntil(now) };
  return { ...form, noEnd: false, until: freeUntilAfter(preset === "3m" ? 3 : 6, now) };
}

/** Which preset the form matches (a date that is not 3 or 6 months from today is custom). */
export function freePresetOf(form: FreeForm, now: Date = new Date()): FreePreset {
  if (form.noEnd) return "none";
  if (form.until === freeUntilAfter(3, now)) return "3m";
  if (form.until === freeUntilAfter(6, now)) return "6m";
  return "custom";
}
