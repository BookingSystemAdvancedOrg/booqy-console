import { api } from "../../api";
import { fmtInt, fmtSek, periodChoices, spanRange } from "../../finance";
import type { TenantSummary } from "../../types";

/**
 * Live numbers in the assistant's answers ("How many customers do we
 * have?", "What is our MRR?"). Read with the operator's own token from the
 * same APIs the pages use (Customers, Finance, Outbox), so the
 * number is the one the page shows. Read only; the server never fetches
 * numbers, it only says which metric (help_assistant.py `live`).
 */

type Source = Pick<typeof api, "tenants" | "financeOverview" | "outbox">;
/** The number as shown, and the count that picks singular or plural ({one|many}). */
type Value = { shown: string; count: number };
type Metric = (src: Source) => Promise<Value | null>;

const count = (n: number): Value => ({ shown: fmtInt(n), count: n });

const tenants = (pick: (t: TenantSummary) => boolean): Metric => async (src) => count((await src.tenants()).filter(pick).length);

type Kpis = Awaited<ReturnType<typeof api.financeOverview>>["kpis"];

/** The billing period in progress, as Finance opens it (25th to today). */
const finance = (value: (k: Kpis) => Value): Metric => async (src) => {
  const range = spanRange(periodChoices(1)[0].from, 1);
  const data = await src.financeOverview(range);
  return data?.kpis ? value(data.kpis) : null;
};
const sek = (n: number): Value => ({ shown: fmtSek(n), count: n });

/** Pages of the outbox read to count it (30 days kept, 50 a page or so). */
const OUTBOX_PAGES = 5;

export const METRICS: Record<string, Metric> = {
  customers: tenants(() => true),
  activeCustomers: tenants((t) => t.status === "active"),
  waitingForStripe: tenants((t) => t.status === "active" && !t.chargesEnabled),
  setupFailed: tenants((t) => t.status === "provisioning_failed"),
  mrr: finance((k) => sek(k.mrrSek)),
  payingCustomers: finance((k) => count(k.payingCustomers)),
  outstanding: finance((k) => sek(k.outstandingSek)),
  outboxMessages: async (src) => {
    let page = await src.outbox();
    if (!page.enabled) return null;
    let n = page.messages.length;
    for (let i = 1; i < OUTBOX_PAGES && page.next; i++) {
      page = await src.outbox(page.next);
      n += page.messages.length;
    }
    return page.next ? { shown: `more than ${fmtInt(n)}`, count: Infinity } : count(n);
  },
};

/**
 * The text with the number: {value} is the number and {one|many} picks the
 * singular when it is 1, else the plural ("1 customer is", "2 customers are").
 */
export function fillLive(text: string, value: Value): string {
  return text.replace(/\{([^{}|]*)\|([^{}|]*)\}/g, (_, one: string, many: string) => (value.count === 1 ? one : many)).replace("{value}", value.shown);
}

/** The answer's text with the number in it ({value}), or null when it can't be had. */
export async function resolveLive(live: { metric: string; text: string }, src: Source = api): Promise<string | null> {
  const metric = METRICS[live.metric];
  if (!metric) return null;
  const value = await metric(src);
  return value === null ? null : fillLive(live.text, value);
}
