// Rule: every user-visible change adds ONE entry here (new n, newest last), only WHERE the change is, 2 to 4 words.
/**
 * "What's new". The build embeds the highest n (BUILT_N) and ships the whole
 * list as /whats-new.json (uploaded with no-cache). When the "A new version
 * is available" notice shows, it lists the entries with n greater than the
 * running build. Examples: "Operators profile picture", "Finance MRR". No
 * verbs, no explanations, no dashes. See README (What's new).
 */

export type WhatsNewEntry = { n: number; text: string };

export const WHATS_NEW: WhatsNewEntry[] = [
  { n: 1, text: "New customer steps" },
  { n: 2, text: "Plan Free options" },
  { n: 3, text: "Finance KPIs" },
  { n: 4, text: "Reports" },
  { n: 5, text: "Phone layout" },
  { n: 6, text: "Tooltips" },
  { n: 7, text: "Ask Booqy button" },
  { n: 8, text: "New dropdowns" },
  { n: 9, text: "Customers list" },
  { n: 10, text: "Bottom navigation" },
  { n: 11, text: "Date fields on phones" },
  { n: 12, text: "My profile" },
  { n: 13, text: "Finance dates and tiles" },
  { n: 14, text: "Profile button" },
  { n: 15, text: "Mouse pointer" },
];

declare const __WHATS_NEW_N__: number | undefined;

/** Highest n in this build (set by vite.config.ts; 0 without Vite). */
export const BUILT_N: number = typeof __WHATS_NEW_N__ === "number" ? __WHATS_NEW_N__ : 0;

/** Highest n in a list. */
export function latestN(list: WhatsNewEntry[]): number {
  return list.reduce((max, e) => Math.max(max, e.n), 0);
}
