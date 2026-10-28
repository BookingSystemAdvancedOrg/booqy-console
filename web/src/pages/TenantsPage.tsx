import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorNotice, Status, fmtDate, useLoad, Printing } from "../components/ui";
import { addDays, customerInvoices, isoDay, monthLabel, type CustomerInvoices } from "../finance";
import type { PaymentRow } from "../types";
import { RefreshButton } from "../components/save";

const FILTERS = ["all", "active", "provisioning", "provisioning_failed", "suspended", "offboarded", "purged"] as const;

export default function TenantsPage() {
  const { data, error, loading, reload } = useLoad(() => api.tenants());
  const [q, setQ] = useState("");
  // Active first: offboarded and other inactive customers are one click away.
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("active");
  // The last year's invoices, per customer: is the latest paid, open or overdue?
  const invoices = useLoad(() => {
    const to = isoDay(new Date());
    return api.financeInvoices({ from: addDays(to, -365), to });
  });
  const billing = useMemo(() => {
    const by = new Map<string, PaymentRow[]>();
    (invoices.data?.invoices ?? []).forEach((r) => by.set(r.tenantId, [...(by.get(r.tenantId) ?? []), r]));
    return new Map([...by].map(([id, rows]) => [id, customerInvoices(rows)]));
  }, [invoices.data]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? []).filter(
      (t) =>
        (filter === "all" || t.status === filter) &&
        (!needle || [t.name, t.slug, t.ownerEmail, t.primaryDomain].some((s) => s?.toLowerCase().includes(needle))),
    );
  }, [data, q, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    (data ?? []).forEach((t) => (c[t.status] = (c[t.status] ?? 0) + 1));
    return c;
  }, [data]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <p className="muted">{data ? `${data.length} restaurants on the platform` : " "}</p>
        </div>
        <div className="row">
          <RefreshButton reload={reload} />
          <Link className="btn btn--primary" to="/tenants/new">+ New customer</Link>
        </div>
      </div>

      <div className="toolbar">
        <input className="input search" placeholder="Search name, slug, owner email, domain…" value={q}
               onChange={(e) => setQ(e.target.value)} />
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f} className={`chip${filter === f ? " chip--on" : ""}`} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : <Status value={f} />}
              {f !== "all" && counts[f] ? <span className="chip__n">{counts[f]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <ErrorNotice error={error} />
      {loading && !data ? <Printing /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th><th>Status</th><th>Plan</th><th>Invoices</th><th>Locations</th><th>Payments</th><th>Site</th><th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.tenantId}>
                  <td>
                    <Link to={`/tenants/${t.tenantId}`} className="strong">{t.name}</Link>
                    <div className="muted small">{t.ownerEmail ?? t.slug}</div>
                  </td>
                  <td><Status value={t.status} /></td>
                  <td>{t.planId}</td>
                  <td><InvoiceCell tenantId={t.tenantId} state={invoices.loading ? null : billing.get(t.tenantId)} /></td>
                  <td>{t.locationCount} / {t.maxLocations ?? "-"}</td>
                  <td>{t.chargesEnabled ? <span className="ok">Ready</span> : <span className="muted">Not ready</span>}</td>
                  <td className="small">{t.primaryDomain ?? <span className="muted">-</span>}</td>
                  <td className="small">{fmtDate(t.createdAt)}</td>
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
function InvoiceCell({ tenantId, state }: { tenantId: string; state: CustomerInvoices | null | undefined }) {
  if (state === null) return <span className="muted small">…</span>;
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
