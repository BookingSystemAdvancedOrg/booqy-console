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
  { n: 16, text: "Customer repos org" },
  { n: 17, text: "Test sites" },
  { n: 18, text: "Own domains" },
  { n: 19, text: "Domains on phones" },
  { n: 20, text: "Ask Booqy error details" },
  { n: 21, text: "Domain orders" },
  { n: 22, text: "Card link return page" },
  { n: 23, text: "Newsletter sending" },
  { n: 24, text: "Operator audit log" },
  { n: 25, text: "Payments status counts" },
  { n: 26, text: "Finance subscription status" },
  { n: 27, text: "Finance customer table" },
  { n: 28, text: "Customer tabs retry" },
  { n: 29, text: "Domain wizard copy" },
  { n: 30, text: "Customers invoices column" },
  { n: 31, text: "Plan names" },
  { n: 32, text: "Plan tab" },
  { n: 33, text: "Mail preview" },
  { n: 34, text: "Meta ads settings" },
  { n: 35, text: "Phone agent settings" },
  { n: 36, text: "Ask Booqy icon" },
  { n: 37, text: "Login storage notice" },
  { n: 38, text: "Operators row menu" },
  { n: 39, text: "Customer tabs layout" },
  { n: 40, text: "Phone tabs and cards" },
  { n: 41, text: "Website KPIs and sources" },
  { n: 42, text: "Dark mode controls" },
  { n: 43, text: "Finance ring legends" },
  { n: 44, text: "Date pickers" },
  { n: 45, text: "Invoice refunds" },
  { n: 46, text: "Settings, new overview" },
  { n: 47, text: "Settings, clearer status" },
  { n: 48, text: "Clearer error messages" },
  { n: 49, text: "Feature descriptions" },
  { n: 50, text: "Plans without site builder" },
  { n: 51, text: "Ordering pickup only" },
  { n: 52, text: "Printer status" },
  { n: 53, text: "Credit dialog wording" },
  { n: 54, text: "Customer owners" },
  { n: 55, text: "Mac icon in dark mode" },
  { n: 56, text: "Customer staff accounts" },
  { n: 57, text: "Back buttons" },
  { n: 58, text: "Save bar on forms" },
  { n: 59, text: "Finance costs in USD" },
];

declare const __WHATS_NEW_N__: number | undefined;

/** Highest n in this build (set by vite.config.ts; 0 without Vite). */
export const BUILT_N: number = typeof __WHATS_NEW_N__ === "number" ? __WHATS_NEW_N__ : 0;

/** Highest n in a list. */
export function latestN(list: WhatsNewEntry[]): number {
  return list.reduce((max, e) => Math.max(max, e.n), 0);
}
