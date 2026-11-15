/**
 * data-help ids for things the help assistant can point at (spotlight.ts).
 * Same rule as helpSlug in scripts/help-corpus.mjs, so ids computed from a
 * label in the code ("kpi:mrr", "card:plan-limits") match the corpus.
 */
export function helpSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
