import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { fmtDay, fmtInt, fmtSek, isoDay, matchesCustomer, monthLabel, monthRange, shiftMonth } from "../finance";
import type { InvoicingRun, PaymentRow } from "../types";
import { ErrorNotice, Modal, Notice, Printing, Status, useAction, useLoad } from "./ui";

const STATUSES = [
  { id: "all", label: "All" }, { id: "paid", label: "Paid" }, { id: "open", label: "Open" }, { id: "overdue", label: "Overdue" },
] as const;
type StatusFilter = (typeof STATUSES)[number]["id"];
const INVOICE_TEXT: Record<string, string> = { draft: "Draft", open: "Open", paid: "Paid", void: "Void", uncollectible: "Uncollectible" };

/** Who has paid for a month: one row per invoice, with reminders and fees. */
export default function PaymentsView() {
  const [month, setMonth] = useState(() => isoDay(new Date()).slice(0, 7));
  const [status, setStatus] = useState<StatusFilter>("all");
  const [needle, setNeedle] = useState("");
  const range = monthRange(month);
  const { data, error, loading, reload } = useLoad(() => api.financeInvoices({ ...range, status }), [month, status]);
  const rows = useMemo(() => (data?.invoices ?? []).filter((r) => matchesCustomer(r, needle)), [data, needle]);
  const thisMonth = isoDay(new Date()).slice(0, 7);
  const s = data?.summary;
  const [invoicing, setInvoicing] = useState(false);

  return (
    <>
      <div className="row payments-actions">
        <p className="muted small">Invoices are created on the 25th for the period from the 25th to the 24th (monthly price plus SMS parts). Run it by hand after a missed 25th, with a preview first.</p>
        <button className="btn btn--primary" onClick={() => setInvoicing(true)}>Run invoicing</button>
      </div>
      {invoicing && <InvoicingModal onClose={() => setInvoicing(false)} onDone={() => { setInvoicing(false); void reload(); }} />}
      <div className="toolbar finance-toolbar">
        <div className="month-pick" role="group" aria-label="Month">
          <button className="btn btn--ghost btn--small" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
          <input className="input month-pick__input" type="month" value={month} max={thisMonth} aria-label="Month"
                 onChange={(e) => { if (e.target.value) setMonth(e.target.value); }} />
          <button className="btn btn--ghost btn--small" aria-label="Next month" disabled={month >= thisMonth}
                  onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
        </div>
        <div className="chips" role="group" aria-label="Status">
          {STATUSES.map((st) => (
            <button key={st.id} className={`chip${status === st.id ? " chip--on" : ""}`} onClick={() => setStatus(st.id)}>
              {st.label}{s && st.id !== "all" ? <span className="chip__n">{st.id === "overdue" ? s.overdue : s[st.id]}</span> : null}
            </button>
          ))}
        </div>
        <input className="input search" placeholder="Customer: name, org. number or slug…" value={needle}
               aria-label="Filter invoices by customer" onChange={(e) => setNeedle(e.target.value)} />
      </div>

      <ErrorNotice error={error} />
      {loading && !data ? <Printing label="Checking payments" /> : data && s && (
        <>
          <section className="kpis kpis--row" aria-label={`Payments ${monthLabel(month)}`}>
            <Kpi label={monthLabel(month)} value={`${fmtInt(s.paid)} of ${fmtInt(s.invoices)} paid`} sub={`${fmtSek(s.collectedSek)} of ${fmtSek(s.invoicedSek)} ex VAT`} />
            <Kpi label="Outstanding" value={fmtSek(s.outstandingSek)} sub={`${fmtInt(s.open)} open invoices`} tone={s.outstandingSek > 0 ? "warn" : undefined} />
            <Kpi label="Overdue" value={fmtSek(s.overdueSek)} sub={`${fmtInt(s.overdue)} past the due date`} tone={s.overdue > 0 ? "bad" : "good"} />
            <Kpi label="Fees and interest" value={fmtSek(s.lateFeesSek + s.interestSek)} sub={`${fmtSek(s.lateFeesSek)} fees, ${fmtSek(s.interestSek, { decimals: true })} interest`} />
          </section>
          {rows.length === 0 ? (
            <Notice kind="info">
              {data.invoices.length === 0
                ? `No invoices for ${monthLabel(month).toLowerCase()}${status !== "all" ? ` with status ${status}` : ""}. Stripe creates them on each customer's billing date.`
                : "No invoice matches that customer."}
            </Notice>
          ) : (
            <div className="table-wrap">
              <table className="table finance-table">
                <thead>
                  <tr><th>Customer</th><th>Invoice</th><th>Status</th><th>Ex VAT</th><th>Total</th><th>Due</th><th>Paid</th><th>Late</th><th>Reminders</th><th>Fees</th><th></th></tr>
                </thead>
                <tbody>{rows.map((r) => <Row key={r.invoiceId} r={r} onChanged={reload} />)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Preview (dry run) of what the 25th would invoice, then the real run. */
function InvoicingModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const preview = useLoad(() => api.financeInvoicing(true));
  const run = useAction();
  const [result, setResult] = useState<InvoicingRun | null>(null);
  const shown = result ?? preview.data;
  return (
    <Modal title={result ? "Invoicing done" : "Run invoicing: preview"} onClose={onClose} wide>
      <div className="stack">
        {preview.loading && !preview.data ? <Printing label="Adding up the periods" /> : shown && (
          <>
            {shown.invoices.length === 0 && shown.errors.length === 0 ? (
              <Notice kind="info">{result ? "Nothing was invoiced." : "Nothing to invoice: every complete period is already invoiced."}</Notice>
            ) : (
              <div className="table-wrap table-wrap--inner">
                <table className="table">
                  <thead><tr><th>Customer</th><th>Period</th><th>Fee</th><th>SMS</th><th>Total ex VAT</th>{result && <th>Result</th>}</tr></thead>
                  <tbody>
                    {shown.invoices.map((i) => (
                      <tr key={`${i.tenantId}-${i.periodEnd}`}>
                        <td className="strong">{i.name}</td>
                        <td className="small">{i.period}{i.activeDays < i.days ? ` (${i.activeDays} of ${i.days} days)` : ""}</td>
                        <td className="num">{fmtSek(i.feeSek, { decimals: true })}</td>
                        <td className="num">{fmtInt(i.smsParts)} × {fmtSek(i.smsPriceSek, { decimals: true })} = {fmtSek(i.smsSek, { decimals: true })}</td>
                        <td className="num">{fmtSek(i.totalSek, { decimals: true })}</td>
                        {result && <td className="small">{i.number ?? i.invoiceId}, {i.delivery}</td>}
                      </tr>
                    ))}
                    {shown.errors.map((e) => (
                      <tr key={e.tenantId}><td className="strong">{e.name}</td><td colSpan={result ? 5 : 4} className="bad">{e.error}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="small muted">
              {shown.invoices.length} invoice{shown.invoices.length === 1 ? "" : "s"}, {fmtSek(shown.totalSek, { decimals: true })} ex VAT
              {shown.skipped?.length ? `; ${shown.skipped.length} period${shown.skipped.length === 1 ? "" : "s"} with nothing to charge` : ""}
              {shown.migrated?.length ? `; ${shown.migrated.length} moved to arrears` : ""}.
            </p>
          </>
        )}
        <ErrorNotice error={preview.error ?? run.error} />
        <div className="row">
          {!result && (
            <button className="btn btn--primary" disabled={run.busy || !preview.data || preview.data.invoices.length === 0}
                    onClick={async () => { const r = await run.run(() => api.financeInvoicing(false)); if (r) setResult(r); }}>
              {run.busy ? "Creating invoices…" : "Create these invoices"}
            </button>
          )}
          <button className="btn btn--ghost" onClick={result ? onDone : onClose}>{result ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </Modal>
  );
}

function Row({ r, onChanged }: { r: PaymentRow; onChanged: () => void }) {
  const remind = useAction();
  const overdue = r.status === "open" && r.daysLate > 0;
  const fees = (Number(r.lateFeeSek) || 0) + (Number(r.interestSek) || 0);
  return (
    <tr className={overdue ? "overdue" : undefined}>
      <td>
        <Link to={`/tenants/${r.tenantId}?tab=billing`} className="strong">{r.name}</Link>
        <div className="muted small mono">{r.orgNumber ?? r.slug}{r.tenantStatus !== "active" ? <> · <Status value={r.tenantStatus} /></> : null}</div>
      </td>
      <td className="mono small">
        {r.hostedInvoiceUrl ? <a href={r.hostedInvoiceUrl} target="_blank" rel="noreferrer">{r.number ?? r.invoiceId}</a> : r.number ?? r.invoiceId}
        <div className="muted">{r.periodStart ? `${fmtDay(r.periodStart)} to ${fmtDay(r.periodEnd)}` : ""}</div>
      </td>
      <td><span className={`status status--invoice-${r.status}`}>{INVOICE_TEXT[r.status] ?? r.status}</span></td>
      <td className="num">{fmtSek(r.subtotalSek)}</td>
      <td className="num">{fmtSek(r.totalSek)}</td>
      <td className="small">{fmtDay(r.dueDate)}</td>
      <td className="small">{r.paidAt ? `${fmtDay(r.paidAt)}${r.paidOutOfBand ? " (bankgiro)" : ""}` : "-"}</td>
      <td className={`num${overdue ? " bad" : ""}`}>{r.daysLate > 0 ? `${r.daysLate} d` : "-"}</td>
      <td className="small">
        {r.remindersSent > 0 ? `${r.remindersSent} sent` : "-"}
        {r.lastReminderAt && <div className="muted">last {fmtDay(r.lastReminderAt)}</div>}
      </td>
      <td className="num">{fees > 0 ? fmtSek(fees, { decimals: true }) : "-"}</td>
      <td>
        {overdue && r.collectionMethod !== "charge_automatically" && (
          <button className="btn btn--small" disabled={remind.busy}
                  onClick={async () => { if (await remind.run(() => api.remindInvoice(r.tenantId, r.invoiceId))) onChanged(); }}>
            {remind.busy ? "Sending…" : "Send reminder"}
          </button>
        )}
        <ErrorNotice error={remind.error} />
      </td>
    </tr>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className={`kpi${tone ? ` kpi--${tone}` : ""}`}>
      <span className="kpi__label">{label}</span>
      <strong className="kpi__value">{value}</strong>
      {sub && <span className="kpi__sub">{sub}</span>}
    </div>
  );
}
