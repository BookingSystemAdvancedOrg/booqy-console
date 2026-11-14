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

/** The default last free day: three months from today (Stockholm). */
export function defaultFreeUntil(now: Date = new Date()): string {
  return addMonths(stockholmToday(now), FREE_MONTHS);
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
