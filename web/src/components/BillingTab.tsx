import { FormEvent, useState } from "react";
import { api } from "../api";
import { INVOICE_STATUS_TEXT, addDays, endDateFor, firstInvoiceText, fmtDay, fmtInt, fmtSek, invoiceStatus, isoDay } from "../finance";
import type { Billing, Invoice, InvoicingRun, Tenant } from "../types";
import { Card, ErrorNotice, Modal, Notice, fmtDate, useAction, useLoad } from "./ui";
import { SaveButton, useFlash } from "./save";
import { SkelCard, SkelPage } from "./Skeleton";
import { fmtFreeDay } from "../free";

const STATUS_TEXT: Record<string, string> = {
  none: "No agreement", scheduled: "Starts later", active: "Active", ending: "Ending", ended: "Ended", past_due: "Past due",
};

/** The customer's agreement, invoiced in advance on the 1st for each calendar
 * month (the first month pro rata from the start day): the monthly price (SMS
 * included; nothing on Free), charged to the restaurant's card or emailed. */
export default function BillingTab({ tenant, cardParam, onChanged }: { tenant: Tenant; cardParam: string | null; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad(() => api.billing(tenant.tenantId), [tenant.tenantId]);
  const act = useAction();
  const link = useAction();
  const invoiceNow = useAction();
  const [start, setStart] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [offboardAtEnd, setOffboardAtEnd] = useState(true);
  const [url, setUrl] = useState<string | null>(null);
  const [run, setRun] = useState<InvoicingRun | null>(null);
  const [started, flashStarted] = useFlash();

  if (loading && !data) return (
    <SkelPage label="Loading billing">
      <SkelCard lines={5} />
      <SkelCard rows={3} cols={3} />
    </SkelPage>
  );
  if (!data) return <ErrorNotice error={error ?? "Not found"} />;
  const b = data.billing;
  const running = b.subscribed;
  // Ended (its last day has passed) but still waiting for its last invoice: a new agreement can start.
  const ended = running && !!b.endsAt && b.endsAt < isoDay(new Date());
  const isTrial = b.terms === "trial";
  const overdue = data.invoices.filter((i) => i.status === "open" && i.daysLate > 0);
  const stamp = (b.pastDueSince || overdue.length) && running ? "past_due" : ended ? "ended" : b.status;
  const pref = b.collectionPreference ?? (b.collectionMethod === "charge_automatically" ? "card" : "invoice");

  async function doAction(action: "cancel" | "cancel_now" | "keep" | "convert" | "use_card" | "collection",
                          options: { offboardAtEnd?: boolean; collectionPreference?: "card" | "invoice" } = {}) {
    if (await act.run(() => api.updateSubscription(tenant.tenantId, action, options))) {
      setConfirmCancel(false);
      void reload();
      onChanged();
    }
  }
  const wouldEnd = endDateFor(b.terms, b.noticeMonths);
  const nxt = b.nextInvoice;

  return (
    <div className="stack">
      <Card title="Agreement" saved={act.done || started} savedLabel={started ? "Started" : "Saved"} actions={<span className="row">
              {overdue.length > 0 && <span className="status status--invoice-overdue" data-testid="overdue-badge">{overdue.length} overdue</span>}
              <span className={`status status--billing-${stamp}`}>{STATUS_TEXT[stamp] ?? stamp}</span></span>}
            info={<>Invoiced in advance: on the 1st, Stripe makes one invoice for that month with the monthly price plus 25 % VAT;
          the first month is invoiced on the start day, pro rata. SMS are included in the price. The Free plan has no charge;
          when it ends the customer rolls over to the price after Free. Card: charged automatically (Stripe retries a failed
          payment); without a card the invoice is emailed, due in 10 days. Invoice: emailed, due in 30 days. Late invoices:
          reminders at {(b.reminderSteps ?? [3, 7, 14]).join(", ")} days and a final notice at {b.finalNoticeDays ?? 30} days, to the
          restaurant and to you; 60 kr reminder fee, förseningsersättning and interest on separate invoices.
          {b.suspendAfterDays > 0 ? ` Suspended after ${b.suspendAfterDays} days past due.` : " Nothing is paused automatically."}</>}>
        {cardParam === "added" && <Notice kind="ok">The card was added in Stripe. It becomes the default by itself and the next invoice is charged to it.</Notice>}
        {b.sellerMissing && b.sellerMissing.length > 0 && running && (
          <Notice kind="warn">Booqy's own details are missing on the invoices: {b.sellerMissing.join(", ")} (billing_seller in the infrastructure tfvars).</Notice>
        )}
        {overdue.length > 0 && (
          <Notice kind="error">
            {overdue.length === 1 ? "One invoice is" : `${overdue.length} invoices are`} overdue, the oldest{" "}
            {Math.max(...overdue.map((i) => i.daysLate))} days. Reminders go out by themselves; nothing is paused.
          </Notice>
        )}
        {b.pastDueSince && <Notice kind="error">A card payment failed on {fmtDate(b.pastDueSince)}; Stripe retries it.{b.autoSuspended ? " The customer was suspended automatically." : ""}</Notice>}
        {running && b.endsAt && (
          <Notice kind="warn">
            {ended
              ? <>The agreement ended on {fmtDay(b.endsAt)}. If the customer comes back, start a new agreement from {fmtDay(addDays(b.endsAt, 1))} or later; days already paid are not charged again.</>
              : <>Cancelled: the agreement ends on {fmtDay(b.endsAt)}; its last month is invoiced pro rata up to that day.</>}
            {b.offboardAtEnd ? " The customer is offboarded automatically after the end date." : " The customer keeps their access until you offboard them."}
            {!ended && <button className="link" disabled={act.busy} onClick={() => doAction("keep")}>Keep the agreement</button>}
          </Notice>
        )}
        {b.pendingPeriods > 0 && (
          <Notice kind="warn">
            {b.cycle === "arrears" ? "The switch to billing in advance is due: one closing invoice" : b.pendingPeriods === 1 ? "One month is" : `${b.pendingPeriods} months are`} not invoiced yet (the
            daily run creates {b.pendingPeriods === 1 ? "it" : "them"}).
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
          <Row label="Plan" value={b.plan.name ? `${b.plan.name}, ${fmtSek(b.plan.priceSek)} per month ex VAT` : tenant.planId} />
          <Row label="This customer pays" value={b.free ? "Nothing (Free)" : `${fmtSek(b.monthlySek)} per month ex VAT${b.priceSek != null ? " (own price)" : ""}`} />
          {b.free && (
            <Row label="Free" value={b.free.until
              ? `Until ${fmtFreeDay(b.free.until)}, then ${b.free.thenPlanName ?? b.free.thenPlanId}${b.free.thenPriceSek != null ? ` (${fmtSek(b.free.thenPriceSek)} per month${b.free.thenOwnPrice ? ", own price" : ""})` : ""} from ${fmtFreeDay(b.free.switchOn ?? b.free.until)}${b.free.noticeSentFor === b.free.until ? "; the owner has been told" : ""}`
              : "No end date: free until the plan is changed"} />
          )}
          <Row label="SMS" value="Included in the price" />
          <Row label="Terms" value={!running && b.status !== "ended" ? undefined : isTrial
            ? `Try-out period${b.termsSince ? ` since ${fmtDay(b.termsSince)}` : ""}: can leave at the end of any month${b.trialEndsAt ? `; becomes a subscription on ${fmtDay(b.trialEndsAt)}` : ""}`
            : `Subscription, ${b.noticeMonths} months' notice${b.termsSince ? ` (since ${fmtDay(b.termsSince)})` : ""}`} />
          <Row label="Runs from" value={b.startsAt ? fmtDay(b.startsAt) : undefined} />
          <Row label="Ends" value={b.endsAt ? fmtDay(b.endsAt) : undefined} />
          {b.previous && b.previous.length > 0 && (
            <Row label="Earlier agreement" value={`${b.previous.map((p) => `${fmtDay(p.startsAt)} to ${fmtDay(p.endsAt)}`).join(", ")}, on the next invoice`} />
          )}
          <dt>Collection</dt>
          <dd>
            <select className="input" style={{ maxWidth: 320 }} aria-label="Collection" value={pref} disabled={act.busy}
                    onChange={(e) => doAction("collection", { collectionPreference: e.target.value as "card" | "invoice" })}>
              <option value="card">Card (automatic)</option>
              <option value="invoice">Invoice (pay within 30 days)</option>
            </select>
            <div className="muted small">
              {pref === "card"
                ? b.hasCard ? "The card is charged on the 1st; Stripe retries a failed payment." : "No card yet: emailed, due in 10 days, until the owner adds one in Booqy Admin (or use the card link)."
                : `Emailed on the 1st, due in ${b.daysUntilDue} days.`}
            </div>
          </dd>
          <Row label="Card" value={b.hasCard ? `${(b.cardBrand ?? "card").toUpperCase()} ending ${b.cardLast4 ?? "????"}${b.cardAddedAt ? `, added ${fmtDay(b.cardAddedAt)}` : ""}` : "None"} />
          <Row label="Invoices go to" value={b.billingEmail ?? undefined} />
          <Row label="Invoiced to" value={b.paidThrough ? fmtDay(b.paidThrough) : running ? "nothing yet" : undefined} />
          <Row label="Stripe customer" value={b.customerId} mono />
          <Row label="Last paid" value={b.lastPaidAt ? fmtDate(b.lastPaidAt) : undefined} />
          <Row label="Started" value={b.startedAt ? `${fmtDate(b.startedAt)} by ${b.startedBy ?? "-"}` : undefined} />
        </dl>

        {nxt && (
          <div className="next-invoice">
            <div className="next-invoice__head">
              <strong>{nxt.kind === "closing" ? "Closing invoice (switch to advance)" : "Next invoice"}: {fmtDay(nxt.date)}</strong>
              <span className="muted small">{nxt.period}{nxt.kind !== "closing" && (nxt.billedDays ?? nxt.days) < nxt.days ? ` (${nxt.billedDays ?? 0} of ${nxt.days} days)` : ""} · in advance · {b.collectionMethod === "charge_automatically" ? "charged to the card" : `due ${fmtDay(nxt.dueDate)}`}</span>
            </div>
            <table className="next-invoice__lines">
              <tbody>
                <tr><td>{nxt.feeText}</td><td className="num">{fmtSek(nxt.feeSek, { decimals: true })}</td></tr>
                <tr className="next-invoice__total"><td>Total ex VAT</td><td className="num">{fmtSek(nxt.totalSek, { decimals: true })}</td></tr>
              </tbody>
            </table>
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
          {running && b.hasCard && pref !== "card" && (
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
                ? <>The customer is in a try-out period: the agreement ends at the end of this month, on <strong>{fmtDay(wouldEnd)}</strong>, which is already invoiced.</>
                : <>Subscription terms: {b.noticeMonths} months' notice. The agreement ends on <strong>{fmtDay(wouldEnd)}</strong>; the customer is invoiced on the 1st of each month until then.</>}
              {" "}The invoices and the Stripe customer stay.
            </p>
            <label className="check">
              <input type="checkbox" checked={offboardAtEnd} onChange={(e) => setOffboardAtEnd(e.target.checked)} />
              Offboard the customer automatically after the end date (users signed out, data deleted after the retention period)
            </label>
            <ErrorNotice error={act.error} />
            <div className="row">
              <button className="btn btn--danger" disabled={act.busy} onClick={() => doAction("cancel", { offboardAtEnd })}>
                {act.busy ? "Cancelling…" : `End on ${fmtDay(wouldEnd)}`}
              </button>
              <button className="btn btn--ghost" onClick={() => setConfirmCancel(false)}>Keep it</button>
              <button className="link danger" disabled={act.busy} onClick={() => doAction("cancel_now", { offboardAtEnd })}>End today instead (the rest of this month is not refunded)</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function StartModal({ tenant, billing, onClose, onDone }: { tenant: Tenant; billing: Billing; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<"card" | "invoice">(billing.collectionPreference ?? "card");
  const [terms, setTerms] = useState<"trial" | "subscription">(billing.terms ?? "trial");
  const [price, setPrice] = useState(billing.monthlySek != null ? String(billing.monthlySek) : "");
  // Never inside a period that is already invoiced, nor on or before the day an ended agreement ended.
  const earliest = [billing.cycle === "advance" ? null : billing.lastInvoicedPeriodEnd, billing.endsAt].filter((d): d is string => !!d)
    .map((d) => addDays(d.slice(0, 10), 1)).sort().pop();
  const today = isoDay(new Date());
  const [startDate, setStartDate] = useState(earliest && earliest > today ? earliest : today);
  const a = useAction();
  const comingBack = !!billing.endsAt && billing.status !== "ended";
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body: { collectionPreference: typeof method; startDate?: string; terms: typeof terms; priceSek?: number } = { collectionPreference: method, terms };
    if (startDate) body.startDate = startDate;
    if (price !== "" && !billing.plan.free) body.priceSek = Number(price);
    if (await a.run(() => api.startSubscription(tenant.tenantId, body))) onDone();
  }
  return (
    <Modal title="Start the agreement" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="small">
          <strong>{billing.plan.name ?? tenant.planId}</strong>: {billing.plan.free ? "no charge while on Free" : `${fmtSek(billing.plan.priceSek)} per month excluding VAT`}, SMS
          included, 25 % VAT on the invoice. Billed to {tenant.legalName ?? tenant.name}{" "}
          ({tenant.billingEmail ?? tenant.ownerEmail ?? "owner email"}). Billed in advance: the first invoice
          comes on the start day for the rest of that month, then on the 1st of every month.
        </p>
        <div className="grid">
          {!billing.plan.free && (
            <label className="field">
              <span className="field__label">Monthly price, SEK ex VAT</span>
              <input className="input mono" type="number" min={0} step={1} value={price} onChange={(e) => setPrice(e.target.value)} />
              <span className="field__hint">Plan price {fmtSek(billing.plan.priceSek)}</span>
            </label>
          )}
          <label className="field">
            <span className="field__label">Runs from</span>
            <input className="input" type="date" value={startDate} min={earliest} onChange={(e) => setStartDate(e.target.value)} />
            <span className="field__hint">
              {startDate ? firstInvoiceText(startDate) : "Today by default."}
              {comingBack && billing.endsAt ? ` Days of the earlier agreement (to ${fmtDay(billing.endsAt)}) that are already paid are not charged again.` : ""}
            </span>
          </label>
        </div>
        <div className="choices">
          <label className={`choice${terms === "trial" ? " choice--on" : ""}`}>
            <input type="radio" name="terms" checked={terms === "trial"} onChange={() => setTerms("trial")} />
            <strong>Try-out period</strong>
            <span className="muted small">Can leave at the end of any month; becomes a subscription after {billing.trialMonths} months.</span>
          </label>
          <label className={`choice${terms === "subscription" ? " choice--on" : ""}`}>
            <input type="radio" name="terms" checked={terms === "subscription"} onChange={() => setTerms("subscription")} />
            <strong>Subscription</strong>
            <span className="muted small">{billing.noticeMonths} months' notice.</span>
          </label>
        </div>
        <div className="choices">
          <label className={`choice${method === "card" ? " choice--on" : ""}`}>
            <input type="radio" name="method" checked={method === "card"} onChange={() => setMethod("card")} />
            <strong>Card (automatic)</strong>
            <span className="muted small">Charged on the 1st.{billing.hasCard ? " A card is on file." : " Until the owner adds a card in Booqy Admin the invoice is emailed, due in 10 days."}</span>
          </label>
          <label className={`choice${method === "invoice" ? " choice--on" : ""}`}>
            <input type="radio" name="method" checked={method === "invoice"} onChange={() => setMethod("invoice")} />
            <strong>Invoice (pay within 30 days)</strong>
            <span className="muted small">Stripe emails the invoice on the 1st. Paid on the invoice page or by bankgiro (mark paid in Stripe).</span>
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
  // Invoices from before SMS were included in the price carry an SMS line: shown only then.
  const smsColumn = invoices.some((i) => Number(i.smsSek) > 0);
  return (
    <Card title="Invoices" saved={remind.done} savedLabel="Reminder sent">
      {invoices.length === 0 ? (
        <p className="muted small">No invoices yet.</p>
      ) : (
        <div className="table-wrap table-wrap--inner">
          <ErrorNotice error={remind.error} />
          <table className="table">
            <thead><tr><th>Number</th><th>Status</th><th>Period</th><th>Fee</th>{smsColumn && <th>SMS</th>}<th>Ex VAT</th><th>Total</th><th>Due</th><th>Paid</th><th>Late</th><th></th></tr></thead>
            <tbody>
              {invoices.map((i) => {
                const overdue = i.status === "open" && i.daysLate > 0;
                const fees = (Number(i.lateFeeSek) || 0) + (Number(i.interestSek) || 0);
                return (
                  <tr key={i.invoiceId}>
                    <td className="mono cell-title">{i.number ?? i.invoiceId}{i.kind === "fees" ? <div className="muted small">Fees</div> : i.kind === "closing" ? <div className="muted small">Closing</div> : null}</td>
                    <td className="cell-badge"><span className={`status status--invoice-${invoiceStatus(i)}`}>{INVOICE_STATUS_TEXT[invoiceStatus(i)] ?? i.status}</span></td>
                    <td className="small" data-label="Period">{i.periodStart ? `${fmtDay(i.periodStart)} to ${fmtDay(i.periodEnd)}` : "-"}</td>
                    <td className="num" data-label="Fee">{i.feeSek != null ? fmtSek(i.feeSek, { decimals: true }) : "-"}</td>
                    {smsColumn && <td className="num" data-label="SMS">{Number(i.smsSek) > 0 ? `${fmtInt(i.smsParts ?? 0)} parts, ${fmtSek(i.smsSek, { decimals: true })}` : "-"}</td>}
                    <td className="num" data-label="Ex VAT">{fmtSek(i.subtotalSek)}</td>
                    <td className="num" data-label="Total">{fmtSek(i.totalSek)}</td>
                    <td className="small cell-fact" data-label="Due">{fmtDay(i.dueDate)}</td>
                    <td className="small cell-fact" data-label="Paid">{i.paidAt ? fmtDay(i.paidAt) + (i.paidOutOfBand ? " (bankgiro)" : "") : "-"}</td>
                    <td className={`small cell-fact${overdue ? " bad" : ""}`} data-label="Late">
                      {i.daysLate > 0 ? `${i.daysLate} days` : "-"}
                      {i.remindersSent > 0 && <div className="muted">{i.reminderStep ? `reminder at day ${i.reminderStep}` : `${i.remindersSent} reminder${i.remindersSent === 1 ? "" : "s"}`}</div>}
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
