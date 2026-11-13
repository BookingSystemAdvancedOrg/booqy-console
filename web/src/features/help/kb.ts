import { isDesktopShell, showDownloadNav } from "../../desktopDownloads";
import data from "./helpKb.json";

/**
 * The help assistant's knowledge: curated English guides (helpKb.json) plus
 * everything the console shows, built from the code (scripts/help-corpus.mjs).
 * The server (application/shared/help_corpus_console.json, copied with
 * `npm run help-kb:sync`) answers from the same corpus.
 *
 * No secrets, keys, infrastructure names or customer data here: the file is
 * sent to the browser and to the language model.
 */

export type HelpAction = {
  id: string;
  label: string;
  /** A path without parameters from main.tsx, e.g. "/finance". */
  to: string;
  query?: Record<string, string>;
  hash?: string;
  /** Lit up after navigating: "help:<data-help id>" or "text:<visible text>". */
  highlight?: string[];
};

/** A live number from the console's own APIs (live.ts), e.g. MRR. */
export type HelpLive = { metric: string; text: string };

export type HelpEntry = {
  id: string;
  /** The page the guide is about (a route from main.tsx), or null. */
  route: string | null;
  title: string;
  audience: "all";
  keywords: string[];
  answer: string;
  steps: string[];
  actions?: HelpAction[];
  /** Suggested question when the assistant opens (three at most are shown). */
  suggestion?: string;
  highlight?: string[];
  live?: HelpLive;
};

/** One part of the corpus: curated guides (kind "guide") and what the console shows (kind "page" and "element"). */
export type HelpDoc = Omit<HelpEntry, "answer" | "steps" | "keywords" | "route" | "audience"> & {
  kind: "guide" | "page" | "element";
  route: string | null;
  hash?: string;
  audience: "all" | "owner";
  /** Where it is, e.g. "a customer's page, Plan tab". */
  where?: string;
  text?: string;
  answer?: string;
  steps?: string[];
  keywords?: string[];
};

export type HelpCorpus = { version: number; app: string; routes: string[]; docs: HelpDoc[] };

export type HelpAnswer = {
  known: boolean;
  text: string;
  steps: string[];
  actions: HelpAction[];
  sources: string[];
  live?: HelpLive;
};

export const KB = data as { version: number; entries: HelpEntry[] };

/** Every route in main.tsx (routes.test.ts keeps this in step). Buttons only go to the static ones. */
export const ROUTE_PATTERNS = [
  "/",
  "/tenants/new",
  "/tenants/:tenantId",
  "/operators",
  "/mail",
  "/finance",
  "/website",
  "/settings",
  "/download",
  "/outbox",
] as const;

// Production is the default; the Outbox only exists in dev (as in main.tsx).
const IS_DEV = (import.meta.env.VITE_ENVIRONMENT ?? "dev") === "dev";
const SAFE = /^[a-z0-9-]{1,40}$/;

/**
 * May the button show? Only static routes from main.tsx, pages this console
 * has (Outbox in dev, Download app where it is offered) and simple query and
 * hash values. Anything else from the server is dropped.
 */
export function actionAllowed(action: HelpAction): boolean {
  if (typeof action?.to !== "string" || typeof action.label !== "string" || !action.label.trim()) return false;
  if (!(ROUTE_PATTERNS as readonly string[]).includes(action.to) || action.to.includes(":")) return false;
  if (action.to === "/download") return false;
  if (action.to === "/outbox" && !IS_DEV) return false;
  if (action.hash === "desktop-app" && (isDesktopShell() || !showDownloadNav())) return false;
  if (action.hash !== undefined && !SAFE.test(action.hash)) return false;
  if (action.query !== undefined) {
    if (typeof action.query !== "object" || action.query === null) return false;
    if (!Object.entries(action.query).every(([k, v]) => SAFE.test(k) && typeof v === "string" && SAFE.test(v))) return false;
  }
  return true;
}

/** "/finance?x=y#z" for an allowed button. */
export function actionHref(action: HelpAction): string {
  const query = action.query ? new URLSearchParams(action.query).toString() : "";
  return `${action.to}${query ? `?${query}` : ""}${action.hash ? `#${action.hash}` : ""}`;
}
