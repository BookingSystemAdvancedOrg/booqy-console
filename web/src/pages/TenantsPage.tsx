import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorNotice, STATUS_TEXT, Status, fmtDate, useLoad } from "../components/ui";
import { Select } from "../components/Select";
import { addDays, customerInvoices, isoDay, monthLabel, type CustomerInvoices } from "../finance";
import type { PaymentRow, TenantSummary } from "../types";
import { RefreshButton } from "../components/save";
import { SkelPage, SkelTable } from "../components/Skeleton";
import { CtaAddLink } from "../components/ds";
import { useRowOpen } from "../components/rowLink";
import { FreeBadge } from "../components/FreeFields";
import { FREE_PLAN_ID } from "../free";
import { planName } from "../components/planName";

const FILTERS = ["all", "active", "provisioning", "provisioning_failed", "suspended", "offboarded", "purged"] as const;
type Filter = (typeof FILTERS)[number];

const digits = (s: string) => s.replace(/\D/g, "");

/** Does a customer match the search? Name, slug, owner email, domain, and the
 * org. number with or without its dash (559123-4567 or 5591234567). */
export function matchesSearch(t: TenantSummary, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if ([t.name, t.slug, t.ownerEmail, t.primaryDomain, t.orgNumber].some((s) => s?.toLowerCase().includes(needle))) return true;
  // only digits, spaces and dashes typed: compare the digits alone
  const d = digits(needle);
  return /^[\d\s-]+$/.test(needle) && d.length >= 3 && !!t.orgNumber && digits(t.orgNumber).includes(d);
}

export default function TenantsPage() {
  const { data, error, loading, reload } = useLoad(() => api.tenants());
  const openRow = useRowOpen();
  const [q, setQ] = useState("");
  // Active first: offboarded and other inactive customers are one click away.
  const [filter, setFilter] = useState<Filter>("active");
  // The last year's invoices, per customer: is the latest paid, open or overdue?
  const invoices = useLoad(() => {
    const to = isoDay(new Date());
    return api.financeInvoices({ from: addDays(to, -365), to });
  });
  const plans = useLoad(() => api.plans());
  const [invoicesRetrying, setInvoicesRetrying] = useState(false);
  const retryInvoices = async () => { setInvoicesRetrying(true); await invoices.reload(); setInvoicesRetrying(false); };
  // Not loaded (null), failed ("unknown"): never "-", which reads as no invoices.
  const invoiceState = (tenantId: string): CustomerInvoices | null | undefined | "unknown" =>
    invoices.loading || invoicesRetrying ? null : invoices.error && !invoices.data ? "unknown" : billing.get(tenantId);
  const billing = useMemo(() => {
    const by = new Map<string, PaymentRow[]>();
    (invoices.data?.invoices ?? []).forEach((r) => by.set(r.tenantId, [...(by.get(r.tenantId) ?? []), r]));
    return new Map([...by].map(([id, rows]) => [id, customerInvoices(rows)]));
  }, [invoices.data]);

  const rows = useMemo(() => {
    return (data ?? []).filter((t) => (filter === "all" || t.status === filter) && matchesSearch(t, q));
  }, [data, q, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    (data ?? []).forEach((t) => (c[t.status] = (c[t.status] ?? 0) + 1));
    return c;
  }, [data]);
  const label = (f: Filter) => (f === "all" ? "All" : STATUS_TEXT[f] ?? f);
  const options = FILTERS.map((f) => ({ value: f, label: label(f), meta: f === "all" ? (data?.length ? String(data.length) : undefined) : counts[f] ? String(counts[f]) : undefined }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <p className="muted" data-help="customers:count">{data ? `${data.length} restaurants` : " "}</p>
        </div>
        <div className="row page-head__actions">
          {/* phones: Refresh is a round icon button beside New customer (styles.css) */}
          <span className="refresh-compact"><RefreshButton reload={reload} /></span>
          <CtaAddLink to="/tenants/new" label="New customer" win="Welcome aboard" />
        </div>
      </div>

      {/* Wide enough: the chip bar. Narrower (phones, tablets): one Status filter
          beside the search, the container query in styles.css picks. */}
      <div className="toolbar tenants-toolbar">
        <input className="input search" aria-label="Search customers" placeholder="Search" value={q}
               onChange={(e) => setQ(e.target.value)} />
        <div className="tenants-filter">
          <Select aria-label="Status filter" className="status-filter" value={filter} options={options}
                  onChange={(v) => setFilter(v as Filter)} />
        </div>
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f} className={`chip${filter === f ? " chip--on" : ""}`} data-help={`customers:filter:${f}`} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : <Status value={f} />}
              {f !== "all" && counts[f] ? <span className="chip__n">{counts[f]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <ErrorNotice error={error} onRetry={() => void reload()} />
      {data && !invoices.data && !invoicesRetrying && <ErrorNotice error={invoices.error} onRetry={() => void retryInvoices()} />}
      {/* A failed load is not an empty list: no "No customers match" under the error. */}
      {loading && !data ? <SkelPage label="Loading customers"><SkelTable rows={6} cols={5} /></SkelPage> : data && (
        <div className="table-wrap">
          <table className="table table--slim">
            <thead>
              <tr>
                <th>Customer</th><th>Status</th><th>Plan</th><th>Invoices</th><th>Locations</th><th data-help="customers:payments">Payments</th><th>Site</th><th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.tenantId} className="row-link" onClick={(e) => openRow(e, `/tenants/${t.tenantId}`)}>
                  <td className="cell-title">
                    <Link to={`/tenants/${t.tenantId}`} className="strong row-link__name">{t.name}</Link>
                    <div className="muted small">{t.ownerEmail ?? t.slug}</div>
                  </td>
                  <td className="cell-badge"><Status value={t.status} /></td>
                  <td className="cell-fact" data-label="Plan">{t.planId === FREE_PLAN_ID ? <FreeBadge until={t.freeUntil ?? null} /> : planName(t.planId, plans.data)}</td>
                  <td className="cell-fact" data-label="Invoices"><InvoiceCell tenantId={t.tenantId} state={invoiceState(t.tenantId)} /></td>
                  <td className="cell-fact" data-label="Locations">{t.locationCount} / {t.maxLocations ?? "-"}</td>
                  <td className="phone-hide" data-label="Payments">{t.chargesEnabled ? <span className="ok">Ready</span> : <span className="muted">Not ready</span>}</td>
                  <td className="small phone-hide" data-label="Site">{t.primaryDomain ?? <span className="muted">-</span>}</td>
                  <td className="small phone-hide" data-label="Created">{fmtDate(t.createdAt)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={8} className="empty">No customers match. <Link to="/tenants/new">Add one</Link></td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Paid, open or overdue: the customer's invoices at a glance, a click from the Billing tab. */
function InvoiceCell({ tenantId, state }: { tenantId: string; state: CustomerInvoices | null | undefined | "unknown" }) {
  if (state === null) return <span className="muted small">…</span>;
  if (state === "unknown") return <span className="muted" title="Invoices did not load" aria-label="Invoices did not load">?</span>;
  if (!state || state.state === "none") return <span className="muted">-</span>;
  const text = { overdue: "Overdue", open: "Open", paid: "Paid" }[state.state];
  const sub = state.state === "overdue" ? `${state.daysLate} ${state.daysLate === 1 ? "day" : "days"} late`
    : state.state === "open" ? `${state.open} not due yet` : state.latestMonth ? monthLabel(state.latestMonth) : "";
  return (
    <Link to={`/tenants/${tenantId}?tab=billing`} className="cell-link">
      <span className={`status status--invoice-${state.state}`}>{text}</span>
      {sub && <div className="muted small">{sub}</div>}
    </Link>
  );
}
