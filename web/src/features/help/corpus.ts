import type { HelpCorpus } from "./kb";

/**
 * The corpus the console builds from its own code (scripts/help-corpus.mjs,
 * public/help-corpus.json in dev; builds also emit a hashed copy for the
 * server). Fetched once, when the assistant first needs it; no-cache so a
 * deploy is picked up.
 */

let corpus: HelpCorpus | null = null;
let loading: Promise<HelpCorpus> | null = null;

export function setCorpus(next: HelpCorpus | null) {
  corpus = next;
  loading = null;
}

export function loadCorpus(): Promise<HelpCorpus> {
  if (corpus) return Promise.resolve(corpus);
  loading ??= fetch(`${import.meta.env.BASE_URL ?? "/"}help-corpus.json`, { cache: "no-cache" })
    .then((r) => {
      if (!r.ok) throw new Error(`help-corpus ${r.status}`);
      return r.json() as Promise<HelpCorpus>;
    })
    .then((c) => (corpus = c))
    .finally(() => {
      loading = null;
    });
  return loading;
}
