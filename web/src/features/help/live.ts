import { api } from "../../api";
import { fmtInt, fmtSek, periodChoices, spanRange } from "../../finance";
import type { TenantSummary } from "../../types";

/**
 * Live numbers in the assistant's answers ("How many customers do we
 * have?", "What is our MRR?"). Read with the operator's own token from the
 * same APIs the pages use (Customers, Finance, Card readers, Outbox), so the
 * number is the one the page shows. Read only; the server never fetches
 * numbers, it only says which metric (help_assistant.py `live`).
 */

type Source = Pick<typeof api, "tenants" | "financeOverview" | "outbox" | "allReaders">;
type Metric = (src: Source) => Promise<string | null>;

const tenants = (pick: (t: TenantSummary) => boolean): Metric => async (src) => fmtInt((await src.tenants()).filter(pick).length);

/** The billing period in progress, as Finance opens it (25th to today). */
const finance = (value: (k: Awaited<ReturnType<typeof api.financeOverview>>["kpis"]) => string): Metric => async (src) => {
  const range = spanRange(periodChoices(1)[0].from, 1);
  const data = await src.financeOverview(range);
  return data?.kpis ? value(data.kpis) : null;
};

/** Pages of the outbox read to count it (30 days kept, 50 a page or so). */
const OUTBOX_PAGES = 5;

export const METRICS: Record<string, Metric> = {
  customers: tenants(() => true),
  activeCustomers: tenants((t) => t.status === "active"),
  waitingForStripe: tenants((t) => t.status === "active" && !t.chargesEnabled),
  setupFailed: tenants((t) => t.status === "provisioning_failed"),
  mrr: finance((k) => fmtSek(k.mrrSek)),
  payingCustomers: finance((k) => fmtInt(k.payingCustomers)),
  outstanding: finance((k) => fmtSek(k.outstandingSek)),
  readers: async (src) => fmtInt((await src.allReaders()).readers.length),
  outboxMessages: async (src) => {
    let page = await src.outbox();
    if (!page.enabled) return null;
    let n = page.messages.length;
    for (let i = 1; i < OUTBOX_PAGES && page.next; i++) {
      page = await src.outbox(page.next);
      n += page.messages.length;
    }
    return page.next ? `more than ${fmtInt(n)}` : fmtInt(n);
  },
};

/** The answer's text with the number in it ({value}), or null when it can't be had. */
export async function resolveLive(live: { metric: string; text: string }, src: Source = api): Promise<string | null> {
  const metric = METRICS[live.metric];
  if (!metric) return null;
  const value = await metric(src);
  return value === null ? null : live.text.replace("{value}", value);
}
