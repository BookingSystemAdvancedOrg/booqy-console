import { FormEvent, useState } from "react";
import { api } from "../api";
import { INVOICE_STATUS_TEXT, addDays, endDateFor, fmtDay, fmtInt, fmtSek, invoiceStatus, isoDay, periodOf, periodText } from "../finance";
import type { Billing, Invoice, InvoicingRun, Tenant } from "../types";
import { Card, ErrorNotice, Modal, Notice, Printing, fmtDate, useAction, useLoad } from "./ui";
import { SaveButton, useFlash } from "./save";

const STATUS_TEXT: Record<string, string> = {
  none: "No agreement", scheduled: "Starts later", active: "Active", ending: "Ending", ended: "Ended", past_due: "Past due",
};

/** The customer's agreement, invoiced in arrears on the 25th for the period
 * from the 25th to the 24th: the monthly price plus the SMS parts sent. */
export default function BillingTab({ tenant, cardParam, onChanged }: { tenant: Tenant; cardParam: string | null; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad(() => api.billing(tenant.tenantId), [tenant.tenantId]);
  const act = useAction();
  const link = useAction();
  const invoiceNow = useAction();
  const [start, setStart] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [offboardAtEnd, setOffboardAtEnd] = useState(true);
  const [url, setUrl] = useState<string | null>(null);
  const [smsPrice, setSmsPrice] = useState<string | null>(null);
  const [run, setRun] = useState<InvoicingRun | null>(null);
  const [started, flashStarted] = useFlash();

  if (loading && !data) return <Printing />;
  if (!data) return <ErrorNotice error={error ?? "Not found"} />;
  const b = data.billing;
  const running = b.subscribed;
  // Ended (its last day has passed) but still waiting for its last invoice: a new agreement can start.
  const ended = running && !!b.endsAt && b.endsAt < isoDay(new Date());
  const isTrial = b.terms === "trial";
  const stamp = b.pastDueSince && running ? "past_due" : ended ? "ended" : b.status;

  async function doAction(action: "cancel" | "cancel_now" | "keep" | "convert" | "use_card" | "set_sms_price",
                          options: { offboardAtEnd?: boolean; smsPriceSek?: number | null } = {}) {
    if (await act.run(() => api.updateSubscription(tenant.tenantId, action, options))) {
      setConfirmCancel(false);
      setSmsPrice(null);
      void reload();
      onChanged();
    }
  }
  const wouldEnd = endDateFor(b.terms, b.noticeMonths);
  const nxt = b.nextInvoice;

  return (
    <div className="stack">
      <Card title="Agreement" saved={act.done || started} savedLabel={started ? "Started" : "Saved"} actions={<span className={`status status--billing-${stamp}`}>{STATUS_TEXT[stamp] ?? stamp}</span>}>
        <p className="muted small">
          Invoiced in arrears: on the 25th, Stripe sends one invoice for the period from the 25th to the 24th that has just
          ended, with the monthly price (pro rata by days for a part period) and one line for the SMS parts sent, plus 25 % VAT.
          Emailed invoices are due {b.daysUntilDue} days later; a card on file is charged on the 25th. Unpaid invoices get
          weekly reminders, the statutory late fee after the grace period and interest when paid; past due for{" "}
          {b.suspendAfterDays} days means suspension until paid.
        </p>
        {cardParam === "added" && <Notice kind="ok">The card was added in Stripe. Press "Charge the card" to use it from the next invoice.</Notice>}
        {b.pastDueSince && <Notice kind="error">Past due since {fmtDate(b.pastDueSince)}{b.autoSuspended ? "; the customer was suspended automatically" : ""}.</Notice>}
        {running && b.endsAt && (
          <Notice kind="warn">
            {ended
              ? <>The agreement ended on {fmtDay(b.endsAt)}; the days used are on the next invoice. If the customer comes back, start a new agreement from {fmtDay(addDays(b.endsAt, 1))} or later.</>
              : <>Cancelled: the agreement ends on {fmtDay(b.endsAt)}; the days used are on the invoice after that.</>}
            {b.offboardAtEnd ? " The customer is offboarded automatically once that invoice is made." : " The customer keeps their access until you offboard them."}
            {!ended && <button className="link" disabled={act.busy} onClick={() => doAction("keep")}>Keep the agreement</button>}
          </Notice>
        )}
        {b.pendingPeriods > 0 && (
          <Notice kind="warn">
            {b.pendingPeriods === 1 ? "One complete period is" : `${b.pendingPeriods} complete periods are`} not invoiced yet (the
            run on the 25th creates them).
            <button className="link" disabled={invoiceNow.busy}
                    onClick={async () => { const r = await invoiceNow.run(() => api.invoiceNow(tenant.tenantId)); if (r) { setRun(r); void reload(); } }}>
              {invoiceNow.busy ? "Invoicing…" : "Invoice now"}
            </button>
          </Notice>
        )}
        {run && (
          <Notice kind={run.errors.length ? "error" : "ok"}>
            {run.invoices.length === 0 ? "Nothing to invoice." : `${run.invoices.length} invoice${run.invoices.length === 1 ? "" : "s"} created, ${fmtSek(run.totalSek, { decimals: true })} ex VAT.`}
            {run.errors.map((e) => <div key={e.tenantId}>{e.error}</div>)}
          </Notice>
        )}
        <ErrorNotice error={invoiceNow.error} />
        {b.plan.priceSek == null && <Notice kind="warn">The plan {b.plan.name ?? tenant.planId} has no price yet (price_sek in the infrastructure tfvars).</Notice>}

        <dl className="dl">
          <Row label="Plan" value={b.plan.name ? `${b.plan.name}, ${fmtSek(b.plan.priceSek)} per period ex VAT` : tenant.planId} />
          <Row label="This customer pays" value={`${fmtSek(b.monthlySek)} per period ex VAT${b.priceSek != null ? " (own price)" : ""}`} />
          <dt>SMS price</dt>
          <dd>
            {smsPrice === null ? (
              <>
                {fmtSek(b.smsPrice, { decimals: true })} per part ex VAT{b.smsPriceSek != null ? " (own price)" : " (default)"}
                <button className="link" onClick={() => setSmsPrice(String(b.smsPrice))}>Change</button>
              </>
            ) : (
              <span className="inline-edit">
                <input className="input mono" type="number" min={0} max={100} step={0.01} value={smsPrice} aria-label="Price per SMS part"
                       onChange={(e) => setSmsPrice(e.target.value)} />
                <SaveButton kind="plain" small type="button" label="Save" busy={act.busy} hint={false} dirty={smsPrice !== String(b.smsPrice)}
                            onClick={() => void doAction("set_sms_price", { smsPriceSek: smsPrice === "" ? null : Number(smsPrice) })} />
                <button className="btn btn--small btn--ghost" onClick={() => doAction("set_sms_price", { smsPriceSek: null })}>Use default ({fmtSek(b.smsPriceDefaultSek, { decimals: true })})</button>
                <button className="link" onClick={() => setSmsPrice(null)}>Cancel</button>
              </span>
            )}
          </dd>
          <Row label="Terms" value={!running && b.status !== "ended" ? undefined : isTrial
            ? `Try-out period${b.termsSince ? ` since ${fmtDay(b.termsSince)}` : ""}: can leave with any period${b.trialEndsAt ? `; becomes a subscription on ${fmtDay(b.trialEndsAt)}` : ""}`
            : `Subscription, ${b.noticeMonths} months' notice${b.termsSince ? ` (since ${fmtDay(b.termsSince)})` : ""}`} />
          <Row label="Runs from" value={b.startsAt ? fmtDay(b.startsAt) : undefined} />
          <Row label="Ends" value={b.endsAt ? fmtDay(b.endsAt) : undefined} />
          {b.previous && b.previous.length > 0 && (
            <Row label="Earlier agreement" value={`${b.previous.map((p) => `${fmtDay(p.startsAt)} to ${fmtDay(p.endsAt)}`).join(", ")}, on the next invoice`} />
          )}
          <Row label="Collection" value={b.collectionMethod === "charge_automatically" ? "Card on file, charged on the 25th" : running ? `Invoice by email, due ${b.daysUntilDue} days after the 25th` : undefined} />
          <Row label="Last invoiced period" value={b.lastInvoicedPeriodEnd ? `to ${fmtDay(b.lastInvoicedPeriodEnd)}` : running ? "nothing yet" : undefined} />
          <Row label="Stripe customer" value={b.customerId} mono />
          <Row label="Last paid" value={b.lastPaidAt ? fmtDate(b.lastPaidAt) : undefined} />
          <Row label="Started" value={b.startedAt ? `${fmtDate(b.startedAt)} by ${b.startedBy ?? "-"}` : undefined} />
        </dl>

        {nxt && (
          <div className="next-invoice">
            <div className="next-invoice__head">
              <strong>Next invoice: {fmtDay(nxt.date)}</strong>
              <span className="muted small">{nxt.period}{nxt.activeDays < nxt.days ? ` (${nxt.activeDays} of ${nxt.days} days)` : ""} · {b.collectionMethod === "charge_automatically" ? "charged to the card" : `due ${fmtDay(nxt.dueDate)}`}</span>
            </div>
            <table className="next-invoice__lines">
              <tbody>
                <tr><td>{nxt.feeText}</td><td className="num">{fmtSek(nxt.feeSek, { decimals: true })}</td></tr>
                <tr><td>{nxt.smsText} so far</td><td className="num">{fmtSek(nxt.smsSek, { decimals: true })}</td></tr>
                <tr className="next-invoice__total"><td>Total ex VAT so far</td><td className="num">{fmtSek(nxt.totalSek, { decimals: true })}</td></tr>
              </tbody>
            </table>
            {nxt.smsByLocation && Object.keys(nxt.smsByLocation).length > 0 && (
              <p className="muted small">SMS per location: {Object.entries(nxt.smsByLocation).map(([n, c]) => `${n} ${fmtInt(c)}`).join(", ")}.</p>
            )}
          </div>
        )}

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
          {(!running || ended) && (
            <button className="btn btn--primary" disabled={!["active", "provisioning"].includes(tenant.status) || b.plan.priceSek == null} onClick={() => setStart(true)}>
              {ended || b.status === "ended" ? "Start a new agreement" : "Start agreement"}
            </button>
          )}
          {running && b.hasCard && b.collectionMethod !== "charge_automatically" && (
            <button className="btn btn--ghost" disabled={act.busy} onClick={() => doAction("use_card")}>Charge the card</button>
          )}
          {running && isTrial && <button className="btn btn--ghost" disabled={act.busy} onClick={() => doAction("convert")}>Convert to subscription</button>}
          <SaveButton kind="ghost" type="button" label="Create card link" busy={link.busy} busyLabel="Creating…" done={link.done} doneLabel="Link ready"
                      onClick={async () => { const r = await link.run(() => api.cardLink(tenant.tenantId)); if (r) setUrl(r.url); }} />
          {running && !b.endsAt && <button className="btn btn--ghost danger" disabled={act.busy} onClick={() => setConfirmCancel(true)}>Cancel agreement</button>}
        </div>
        {!running && !["active", "provisioning"].includes(tenant.status) && <p className="muted small">An agreement can be started for an active customer.</p>}
      </Card>

      <Invoices invoices={data.invoices} tenantId={tenant.tenantId} onChanged={() => void reload()} />

      {start && (
        <StartModal tenant={tenant} billing={b} onClose={() => setStart(false)}
                    onDone={() => { setStart(false); flashStarted(); void reload(); onChanged(); }} />
      )}
      {confirmCancel && (
        <Modal title="Cancel the agreement?" onClose={() => setConfirmCancel(false)}>
          <div className="stack">
            <p>
              {isTrial
                ? <>The customer is in a try-out period: the agreement ends with the current period, on <strong>{fmtDay(wouldEnd)}</strong>, and that period is invoiced in full on {fmtDay(nxt?.date ?? addDays(wouldEnd, 1))}.</>
                : <>Subscription terms: {b.noticeMonths} months' notice. The agreement ends on <strong>{fmtDay(wouldEnd)}</strong>; the customer is invoiced for each period until then.</>}
              {" "}The invoices and the Stripe customer stay.
            </p>
            <label className="check">
              <input type="checkbox" checked={offboardAtEnd} onChange={(e) => setOffboardAtEnd(e.target.checked)} />
              Offboard the customer automatically once the final invoice is made (users signed out, data deleted after the retention period)
            </label>
            <ErrorNotice error={act.error} />
            <div className="row">
              <button className="btn btn--danger" disabled={act.busy} onClick={() => doAction("cancel", { offboardAtEnd })}>
                {act.busy ? "Cancelling…" : `End on ${fmtDay(wouldEnd)}`}
              </button>
              <button className="btn btn--ghost" onClick={() => setConfirmCancel(false)}>Keep it</button>
              <button className="link danger" disabled={act.busy} onClick={() => doAction("cancel_now", { offboardAtEnd })}>End today instead (the days used go on the next invoice)</button>
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
  // Never inside a period that is already invoiced, nor on or before the day an ended agreement ended.
  const earliest = [billing.lastInvoicedPeriodEnd, billing.endsAt].filter((d): d is string => !!d)
    .map((d) => addDays(d.slice(0, 10), 1)).sort().pop();
  const today = isoDay(new Date());
  const [startDate, setStartDate] = useState(earliest && earliest > today ? earliest : today);
  const a = useAction();
  const { start, end } = startDate ? periodOf(startDate) : { start: "", end: "" };
  const comingBack = !!billing.endsAt && billing.status !== "ended";
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: { collectionMethod: typeof method; startDate?: string; terms: typeof terms; priceSek?: number } = { collectionMethod: method, terms };
    if (startDate) body.startDate = startDate;
    if (price !== "") body.priceSek = Number(price);
    if (await a.run(() => api.startSubscription(tenant.tenantId, body))) onDone();
  }
  return (
    <Modal title="Start the agreement" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small">
          <strong>{billing.plan.name ?? tenant.planId}</strong>: {fmtSek(billing.plan.priceSek)} per period excluding VAT, SMS at{" "}
          {fmtSek(billing.smsPrice, { decimals: true })} per part, 25 % VAT on the invoice. Billed to {tenant.legalName ?? tenant.name}{" "}
          ({tenant.billingEmail ?? tenant.ownerEmail ?? "owner email"}). Nothing is charged now: the first invoice comes on the 25th after the
          first period, for the days used.
        </p>
        <div className="grid">
          <label className="field">
            <span className="field__label">Monthly price, SEK ex VAT</span>
            <input className="input mono" type="number" min={0} step={1} value={price} onChange={(e) => setPrice(e.target.value)} />
            <span className="field__hint">The plan's price is {fmtSek(billing.plan.priceSek)}; a different amount is this customer's own price.</span>
          </label>
          <label className="field">
            <span className="field__label">Runs from</span>
            <input className="input" type="date" value={startDate} min={earliest} onChange={(e) => setStartDate(e.target.value)} />
            <span className="field__hint">
              {start ? `First invoice on ${fmtDay(addDays(end, 1))} for ${periodText(start, end)}, pro rata from this date.` : "Today by default."}
              {comingBack && billing.endsAt ? ` The earlier agreement (to ${fmtDay(billing.endsAt)}) goes on the same invoice, so the customer pays for both stretches and not the days between.` : ""}
            </span>
          </label>
        </div>
        <div className="choices">
          <label className={`choice${terms === "trial" ? " choice--on" : ""}`}>
            <input type="radio" name="terms" checked={terms === "trial"} onChange={() => setTerms("trial")} />
            <strong>Try-out period</strong>
            <span className="muted small">Can leave with any period; becomes a subscription after {billing.trialMonths} months.</span>
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
            <span className="muted small">Stripe emails the invoice on the 25th, due in {billing.daysUntilDue} days. Paid by card on the invoice page or by bankgiro (mark paid in Stripe).</span>
          </label>
          <label className={`choice${method === "charge_automatically" ? " choice--on" : ""}`}>
            <input type="radio" name="method" checked={method === "charge_automatically"} onChange={() => setMethod("charge_automatically")} />
            <strong>Charge a card on file</strong>
            <span className="muted small">Charged on the 25th. Needs a card added through a card link first.{billing.hasCard ? " A card is on file." : ""}</span>
          </label>
        </div>
        <ErrorNotice error={a.error} />
        <div className="row">
          <button className="btn btn--primary" type="submit" disabled={a.busy}>{a.busy ? "Starting…" : "Start agreement"}</button>
          <button className="btn btn--ghost" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function Invoices({ invoices, tenantId, onChanged }: { invoices: Invoice[]; tenantId: string; onChanged: () => void }) {
  const remind = useAction();
  return (
    <Card title="Invoices" saved={remind.done} savedLabel="Reminder sent">
      {invoices.length === 0 ? (
        <p className="muted small">No invoices yet. The first one is created on the 25th after the first period (and after "Import from Stripe" on the Finance page for older ones).</p>
      ) : (
        <div className="table-wrap table-wrap--inner">
          <ErrorNotice error={remind.error} />
          <table className="table">
            <thead><tr><th>Number</th><th>Status</th><th>Period</th><th>Fee</th><th>SMS</th><th>Ex VAT</th><th>Total</th><th>Due</th><th>Paid</th><th>Late</th><th></th></tr></thead>
            <tbody>
              {invoices.map((i) => {
                const overdue = i.status === "open" && i.daysLate > 0;
                const fees = (Number(i.lateFeeSek) || 0) + (Number(i.interestSek) || 0);
                return (
                  <tr key={i.invoiceId}>
                    <td className="mono">{i.number ?? i.invoiceId}</td>
                    <td><span className={`status status--invoice-${invoiceStatus(i)}`}>{INVOICE_STATUS_TEXT[invoiceStatus(i)] ?? i.status}</span></td>
                    <td className="small">{i.periodStart ? `${fmtDay(i.periodStart)} to ${fmtDay(i.periodEnd)}` : "-"}</td>
                    <td className="num">{i.feeSek != null ? fmtSek(i.feeSek, { decimals: true }) : "-"}</td>
                    <td className="num">{i.smsParts != null ? `${fmtInt(i.smsParts)} parts${i.smsSek != null ? `, ${fmtSek(i.smsSek, { decimals: true })}` : ""}` : "-"}</td>
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
