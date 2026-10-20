import { FormEvent, useState } from "react";
import { api } from "../api";
import { addMonths, fmtDay, fmtSek, isoDay } from "../finance";
import type { Billing, Invoice, Tenant } from "../types";
import { Card, ErrorNotice, Modal, Notice, Printing, fmtDate, useAction, useLoad } from "./ui";

const STATUS_TEXT: Record<string, string> = {
  none: "No subscription", active: "Active", trialing: "Trial", past_due: "Past due", unpaid: "Unpaid",
  canceled: "Cancelled", incomplete: "Incomplete", incomplete_expired: "Expired", unknown: "Unknown",
};
const INVOICE_TEXT: Record<string, string> = { draft: "Draft", open: "Open", paid: "Paid", void: "Void", uncollectible: "Uncollectible" };

function billingStatus(b: Billing): string {
  if (!b.subscriptionId || b.status === "canceled" || b.status === "incomplete_expired") return "none";
  if (b.pauseCollection) return "paused";
  return b.status ?? "unknown";
}

/** The customer's SaaS subscription: start, pause, cancel, card, invoices. */
export default function BillingTab({ tenant, cardParam, onChanged }: { tenant: Tenant; cardParam: string | null; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad(() => api.billing(tenant.tenantId), [tenant.tenantId]);
  const act = useAction();
  const link = useAction();
  const [start, setStart] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [offboardAtEnd, setOffboardAtEnd] = useState(true);
  const [url, setUrl] = useState<string | null>(null);

  if (loading && !data) return <Printing />;
  if (!data) return <ErrorNotice error={error ?? "Not found"} />;
  const b = data.billing;
  const status = billingStatus(b);
  const running = b.subscribed;

  async function run(action: "pause" | "resume" | "cancel" | "cancel_now" | "keep" | "convert" | "sync_price" | "use_card",
                     options: { offboardAtEnd?: boolean } = {}) {
    if (await act.run(() => api.updateSubscription(tenant.tenantId, action, options))) { setConfirmCancel(false); void reload(); onChanged(); }
  }
  const isTrial = b.terms === "trial";
  // When a cancellation would take effect: a try-out with the paid month, a subscription after the notice.
  const periodEnd = b.currentPeriodEnd ? b.currentPeriodEnd.slice(0, 10) : addMonths(isoDay(new Date()), 1);
  const wouldEnd = isTrial ? periodEnd : addMonths(periodEnd, b.noticeMonths);

  return (
    <div className="stack">
      <Card title="Subscription" actions={<span className={`status status--billing-${status}`}>{STATUS_TEXT[status] ?? status}</span>}>
        <p className="muted small">
          Invoiced monthly through Stripe Billing on your platform account: the plan price plus 25 % VAT. Stripe emails
          the invoice; the restaurant pays by card on the invoice page, automatically with a card on file, or by bankgiro
          to your account (then mark the invoice paid in Stripe). An unpaid invoice is reminded about weekly after its due
          date, gets the statutory late fee after the grace period and interest for the days late on the next invoice; a
          customer past due for {b.suspendAfterDays} days is suspended automatically{b.suspendAfterDays === 0 ? " (off)" : ""}{" "}
          and resumed when they pay.
        </p>
        {cardParam === "added" && <Notice kind="ok">The card was added in Stripe. Press "Charge the card" to use it for the subscription.</Notice>}
        {b.priceDiffers && (
          <Notice kind="warn">
            The plan's price changed ({fmtSek(b.plan.priceSek)} per month). This subscription still runs on the old price.
            <button className="link" disabled={act.busy} onClick={() => run("sync_price")}>Update to the plan price</button>
          </Notice>
        )}
        {b.pastDueSince && <Notice kind="error">Past due since {fmtDate(b.pastDueSince)}{b.autoSuspended ? "; the customer was suspended automatically" : ""}.</Notice>}
        {running && b.endsAt && (
          <Notice kind="warn">
            Cancelled: the subscription ends on {fmtDay(b.endsAt)}{b.offboardAtEnd ? " and the customer is offboarded automatically then" : "; the customer keeps their access until you offboard them"}.
            <button className="link" disabled={act.busy} onClick={() => run("keep")}>Keep the subscription</button>
          </Notice>
        )}
        {!b.plan.stripePriceId && <Notice kind="warn">The plan {b.plan.name ?? tenant.planId} has no Stripe price yet (price_sek in the infrastructure tfvars).</Notice>}
        <dl className="dl">
          <Row label="Plan" value={b.plan.name ? `${b.plan.name}, ${fmtSek(b.plan.priceSek)} per month ex VAT` : tenant.planId} />
          <Row label="This customer pays" value={b.monthlySek != null ? `${fmtSek(b.monthlySek)} per month ex VAT${b.priceSek != null ? " (own price)" : ""}` : undefined} />
          <Row label="Terms" value={isTrial
            ? `Try-out period${b.termsSince ? ` since ${fmtDay(b.termsSince)}` : ""}: can leave at the end of any paid month${b.trialEndsAt ? `; becomes a subscription on ${fmtDay(b.trialEndsAt)}` : ""}`
            : `Subscription, ${b.noticeMonths} months' notice${b.termsSince ? ` (since ${fmtDay(b.termsSince)})` : ""}`} />
          <Row label="Stripe customer" value={b.customerId} mono />
          <Row label="Subscription" value={b.subscriptionId} mono />
          <Row label="MRR" value={running ? fmtSek(b.mrrSek) : undefined} />
          <Row label="Collection" value={b.collectionMethod === "charge_automatically" ? "Card on file, charged automatically" : b.collectionMethod === "send_invoice" ? `Invoice by email, due in ${b.daysUntilDue} days` : undefined} />
          <Row label="Trial until" value={b.trialEnd && b.status === "trialing" ? fmtDay(b.trialEnd) : undefined} />
          <Row label="Current period" value={b.currentPeriodStart ? `${fmtDay(b.currentPeriodStart)} to ${fmtDay(b.currentPeriodEnd)}` : undefined} />
          <Row label="Ends" value={b.cancelAt ? fmtDay(b.cancelAt) : b.canceledAt ? `Cancelled ${fmtDay(b.canceledAt)}` : undefined} />
          <Row label="Last paid" value={b.lastPaidAt ? fmtDate(b.lastPaidAt) : undefined} />
          <Row label="Started" value={b.startedAt ? `${fmtDate(b.startedAt)} by ${b.startedBy ?? "-"}` : undefined} />
        </dl>
        <ErrorNotice error={act.error ?? link.error} />
        {url && (
          <Notice kind="ok">
            Card link for the restaurant (Stripe Checkout, valid 24 hours):
            <div className="copy"><input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} />
              <button className="btn btn--small" onClick={() => navigator.clipboard.writeText(url)}>Copy</button>
              <a className="btn btn--small" href={url} target="_blank" rel="noreferrer">Open</a></div>
          </Notice>
        )}
        <div className="row">
          {!running && (
            <button className="btn btn--primary" disabled={tenant.status !== "active" || !b.plan.stripePriceId} onClick={() => setStart(true)}>
              Start subscription
            </button>
          )}
          {running && !b.pauseCollection && <button className="btn btn--ghost" disabled={act.busy} onClick={() => run("pause")}>Pause invoicing</button>}
          {running && b.pauseCollection && <button className="btn btn--primary" disabled={act.busy} onClick={() => run("resume")}>Resume invoicing</button>}
          {running && b.collectionMethod !== "charge_automatically" && (
            <button className="btn btn--ghost" disabled={act.busy} onClick={() => run("use_card")}>Charge the card</button>
          )}
          {running && isTrial && <button className="btn btn--ghost" disabled={act.busy} onClick={() => run("convert")}>Convert to subscription</button>}
          <button className="btn btn--ghost" disabled={link.busy}
                  onClick={async () => { const r = await link.run(() => api.cardLink(tenant.tenantId)); if (r) setUrl(r.url); }}>
            {link.busy ? "Creating…" : "Create card link"}
          </button>
          {running && !b.endsAt && <button className="btn btn--ghost danger" disabled={act.busy} onClick={() => setConfirmCancel(true)}>Cancel subscription</button>}
        </div>
        {tenant.status !== "active" && !running && <p className="muted small">A subscription can be started for an active customer.</p>}
      </Card>

      <Invoices invoices={data.invoices} tenantId={tenant.tenantId} onChanged={() => void reload()} />

      {start && (
        <StartModal tenant={tenant} billing={b} onClose={() => setStart(false)}
                    onDone={() => { setStart(false); void reload(); onChanged(); }} />
      )}
      {confirmCancel && (
        <Modal title="Cancel the subscription?" onClose={() => setConfirmCancel(false)}>
          <div className="stack">
            <p>
              {isTrial
                ? <>The customer is in a try-out period: the subscription ends with the paid month, on <strong>{fmtDay(wouldEnd)}</strong>. No more invoices.</>
                : <>Subscription terms: {b.noticeMonths} months' notice. The subscription ends on <strong>{fmtDay(wouldEnd)}</strong>; the customer is invoiced until then.</>}
              {" "}The invoices and the Stripe customer stay.
            </p>
            <label className="check">
              <input type="checkbox" checked={offboardAtEnd} onChange={(e) => setOffboardAtEnd(e.target.checked)} />
              Offboard the customer automatically when it ends (users signed out, data deleted after the retention period)
            </label>
            <ErrorNotice error={act.error} />
            <div className="row">
              <button className="btn btn--danger" disabled={act.busy} onClick={() => run("cancel", { offboardAtEnd })}>
                {act.busy ? "Cancelling…" : `End on ${fmtDay(wouldEnd)}`}
              </button>
              <button className="btn btn--ghost" onClick={() => setConfirmCancel(false)}>Keep it</button>
              <button className="link danger" disabled={act.busy} onClick={() => run("cancel_now", { offboardAtEnd })}>End today instead (final invoice now)</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function StartModal({ tenant, billing, onClose, onDone }: { tenant: Tenant; billing: Billing; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<"send_invoice" | "charge_automatically">("send_invoice");
  const [terms, setTerms] = useState<"trial" | "subscription">(billing.terms ?? "trial");
  const [price, setPrice] = useState(billing.monthlySek != null ? String(billing.monthlySek) : "");
  const [startDate, setStartDate] = useState("");
  const a = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: { collectionMethod: typeof method; startDate?: string; terms: typeof terms; priceSek?: number } = { collectionMethod: method, terms };
    if (startDate) body.startDate = startDate;
    if (price !== "") body.priceSek = Number(price);
    if (await a.run(() => api.startSubscription(tenant.tenantId, body))) onDone();
  }
  return (
    <Modal title="Start subscription" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small">
          <strong>{billing.plan.name ?? tenant.planId}</strong>: {fmtSek(billing.plan.priceSek)} per month excluding VAT, 25 % VAT
          added on the invoice. Billed to {tenant.legalName ?? tenant.name} ({tenant.billingEmail ?? tenant.ownerEmail ?? "owner email"}).
        </p>
        <div className="grid">
          <label className="field">
            <span className="field__label">Monthly price, SEK ex VAT</span>
            <input className="input mono" type="number" min={0} step={1} value={price} onChange={(e) => setPrice(e.target.value)} />
            <span className="field__hint">The plan's price is {fmtSek(billing.plan.priceSek)}; a different amount is this customer's own price.</span>
          </label>
        </div>
        <div className="choices">
          <label className={`choice${terms === "trial" ? " choice--on" : ""}`}>
            <input type="radio" name="terms" checked={terms === "trial"} onChange={() => setTerms("trial")} />
            <strong>Try-out period</strong>
            <span className="muted small">Can leave at the end of any paid month; becomes a subscription after {billing.trialMonths} months.</span>
          </label>
          <label className={`choice${terms === "subscription" ? " choice--on" : ""}`}>
            <input type="radio" name="terms" checked={terms === "subscription"} onChange={() => setTerms("subscription")} />
            <strong>Subscription</strong>
            <span className="muted small">{billing.noticeMonths} months' notice.</span>
          </label>
        </div>
        <div className="choices">
          <label className={`choice${method === "send_invoice" ? " choice--on" : ""}`}>
            <input type="radio" name="method" checked={method === "send_invoice"} onChange={() => setMethod("send_invoice")} />
            <strong>Invoice by email</strong>
            <span className="muted small">Stripe emails the invoice, due in {billing.daysUntilDue} days. Paid by card on the invoice page or by bankgiro (mark paid in Stripe).</span>
          </label>
          <label className={`choice${method === "charge_automatically" ? " choice--on" : ""}`}>
            <input type="radio" name="method" checked={method === "charge_automatically"} onChange={() => setMethod("charge_automatically")} />
            <strong>Charge a card on file</strong>
            <span className="muted small">Needs a card added through a card link first.{billing.hasCard ? " A card is on file." : ""}</span>
          </label>
        </div>
        <label className="field">
          <span className="field__label">First invoice date (optional)</span>
          <input className="input" type="date" value={startDate} min={isoDay(new Date())} onChange={(e) => setStartDate(e.target.value)} />
          <span className="field__hint">Leave empty to start today. A later date delays the first invoice until then; nothing is charged before.</span>
        </label>
        <ErrorNotice error={a.error} />
        <div className="row">
          <button className="btn btn--primary" type="submit" disabled={a.busy}>{a.busy ? "Starting…" : "Start subscription"}</button>
          <button className="btn btn--ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function Invoices({ invoices, tenantId, onChanged }: { invoices: Invoice[]; tenantId: string; onChanged: () => void }) {
  const remind = useAction();
  return (
    <Card title="Invoices">
      {invoices.length === 0 ? (
        <p className="muted small">No invoices yet. They appear here when Stripe creates them (and after "Import from Stripe" on the Finance page).</p>
      ) : (
        <div className="table-wrap table-wrap--inner">
          <ErrorNotice error={remind.error} />
          <table className="table">
            <thead><tr><th>Number</th><th>Status</th><th>Period</th><th>Ex VAT</th><th>Total</th><th>Due</th><th>Paid</th><th>Late</th><th></th></tr></thead>
            <tbody>
              {invoices.map((i) => {
                const overdue = i.status === "open" && i.daysLate > 0;
                const fees = (Number(i.lateFeeSek) || 0) + (Number(i.interestSek) || 0);
                return (
                  <tr key={i.invoiceId}>
                    <td className="mono">{i.number ?? i.invoiceId}</td>
                    <td><span className={`status status--invoice-${i.status}`}>{INVOICE_TEXT[i.status] ?? i.status}</span></td>
                    <td className="small">{i.periodStart ? `${fmtDay(i.periodStart)} to ${fmtDay(i.periodEnd)}` : "-"}</td>
                    <td className="num">{fmtSek(i.subtotalSek)}</td>
                    <td className="num">{fmtSek(i.totalSek)}</td>
                    <td className="small">{fmtDay(i.dueDate)}</td>
                    <td className="small">{i.paidAt ? fmtDay(i.paidAt) + (i.paidOutOfBand ? " (bankgiro)" : "") : "-"}</td>
                    <td className={`small${overdue ? " bad" : ""}`}>
                      {i.daysLate > 0 ? `${i.daysLate} days` : "-"}
                      {i.remindersSent > 0 && <div className="muted">{i.remindersSent} reminder{i.remindersSent === 1 ? "" : "s"}</div>}
                      {fees > 0 && <div className="muted">{fmtSek(fees, { decimals: true })} fees</div>}
                    </td>
                    <td className="small">
                      {i.hostedInvoiceUrl && <a href={i.hostedInvoiceUrl} target="_blank" rel="noreferrer">Open</a>}
                      {i.invoicePdf && <> · <a href={i.invoicePdf} target="_blank" rel="noreferrer">PDF</a></>}
                      {overdue && i.collectionMethod !== "charge_automatically" && (
                        <div><button className="link" disabled={remind.busy}
                                     onClick={async () => { if (await remind.run(() => api.remindInvoice(tenantId, i.invoiceId))) onChanged(); }}>
                          {remind.busy ? "Sending…" : "Send reminder"}
                        </button></div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono && value ? "mono" : undefined}>{value ?? <span className="muted">-</span>}</dd>
    </>
  );
}
