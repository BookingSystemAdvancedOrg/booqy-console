import { useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { fmtDay, fmtSek, parseSek } from "../finance";
import type { CreditNotesResponse, Invoice } from "../types";
import { ErrorNotice, Modal, useAction } from "./ui";
import { Select } from "./Select";
import { InfoTip } from "./InfoTip";
import "./refunds.css";

export type CreditMethod = "refund" | "credit";

const REASONS = [
  { value: "other", label: "Other" },
  { value: "duplicate", label: "Duplicate" },
  { value: "order_change", label: "Order change" },
  { value: "product_unsatisfactory", label: "Not satisfied" },
  { value: "fraudulent", label: "Fraudulent" },
];

const left = (i: Invoice) => Number(i.creditableSek) || 0;
/** Back to the card: only a paid invoice, paid by card (not outside Stripe). */
const cardOk = (i: Invoice) => i.status === "paid" && i.refundable !== false;
const asText = (n: number) => n.toFixed(2).replace(".", ",");

/** The credit choice, worded by what it does: on an open invoice it lowers what is owed, on a paid one the next invoice. */
export function creditLabel(invoices: Invoice[]): string {
  const open = invoices.filter((i) => i.status === "open").length;
  if (open === 0) return "Credit next invoice";
  if (open === invoices.length) return "Lower what is owed";
  return "Lower owed or next invoice";
}

function newRequestId(): string {
  try { return crypto.randomUUID(); } catch { return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
}

/** A failed invoice's result as an error the ErrorNotice can tell who acts on (a Booqy fault gets Copy details). */
function rowError(code: string, message: string): ApiError {
  const e = new ApiError(code === "internal_error" ? 500 : 409, code, message);
  e.serverMessage = message;
  return e;
}

/** Refund (back to the card) or credit (to the customer's Stripe balance, so the next invoice is lower; on an
 * open invoice it lowers what is owed) one or more invoices. One request id per dialog: a repeated or retried
 * request never refunds twice (the api finds a note this dialog made by it). Always the amount the operator
 * confirmed, never "whatever is left". A retry of an invoice that failed is a new attempt, so Stripe does not
 * answer it with the failure it stored for the earlier one. */
export function RefundModal({ tenantId, invoices, onClose, onDone }: {
  tenantId: string; invoices: Invoice[]; onClose: () => void;
  /** After any success: what went through, and whether the dialog is finished (nothing failed). */
  onDone: (res: CreditNotesResponse, finished: boolean) => void;
}) {
  const allCard = invoices.every(cardOk);
  const [rows, setRows] = useState(invoices);
  const [method, setMethod] = useState<CreditMethod>(allCard ? "refund" : "credit");
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(invoices.map((i) => [i.invoiceId, asText(left(i))])));
  const [reason, setReason] = useState("other");
  const [memo, setMemo] = useState("");
  const [failed, setFailed] = useState<Record<string, ApiError>>({});
  const attempts = useRef<Record<string, number>>({});
  const requestId = useRef(newRequestId());
  const a = useAction();

  const parsed = useMemo(() => Object.fromEntries(rows.map((i) => [i.invoiceId, parseSek(amounts[i.invoiceId] ?? "")])), [rows, amounts]);
  const bad = (i: Invoice) => {
    const v = parsed[i.invoiceId];
    if (v === null || v === undefined || v <= 0) return "Enter an amount";
    if (v > left(i) + 0.001) return `At most ${fmtSek(left(i), { decimals: true })}`;
    if (method === "refund" && !cardOk(i)) return i.status === "paid" ? "Paid outside Stripe: credit it" : "Not paid yet: credit it";
    return null;
  };
  const total = rows.reduce((s, i) => s + (Number(parsed[i.invoiceId]) || 0), 0);
  const invalid = rows.some((i) => bad(i));
  const verb = method === "refund" ? "Refund" : "Credit";

  function cap(i: Invoice) {
    const v = parsed[i.invoiceId];
    if (v !== null && v !== undefined && v > left(i)) setAmounts((m) => ({ ...m, [i.invoiceId]: asText(left(i)) }));
    else if (v !== null && v !== undefined) setAmounts((m) => ({ ...m, [i.invoiceId]: asText(v) }));
  }

  async function submit() {
    if (invalid || a.busy) return;
    const items = rows.map((i) => {
      const attempt = attempts.current[i.invoiceId] ?? 0;
      return { invoiceId: i.invoiceId, amountSek: (parsed[i.invoiceId] as number).toFixed(2), ...(attempt ? { attempt } : {}) };
    });
    const res = await a.run(() => api.creditNotes(tenantId, { items, method, reason, memo: memo.trim() || undefined, requestId: requestId.current }));
    if (!res) return;
    const errors: Record<string, ApiError> = {};
    for (const r of res.results) {
      if (r.ok) continue;
      errors[r.invoiceId] = rowError(r.error, r.message);
      attempts.current[r.invoiceId] = (attempts.current[r.invoiceId] ?? 0) + 1;
    }
    const finished = res.failed === 0;
    if (!finished) {
      // the ones that went through leave the dialog; the rest stay with their reason, same request id and a new attempt for a retry
      setRows((rs) => rs.filter((i) => errors[i.invoiceId]));
      setFailed(errors);
    }
    if (res.ok > 0 || finished) onDone(res, finished);
  }

  return (
    <Modal title={rows.length === 1 ? `${verb} invoice ${rows[0].number ?? rows[0].invoiceId}` : `${verb} ${rows.length} invoices`} onClose={() => { if (!a.busy) onClose(); }} wide>
      <div className="stack refund">
        <div className="seg refund__method" role="radiogroup" aria-label="Where the money goes">
          <button type="button" role="radio" aria-checked={method === "refund"} disabled={!allCard}
                  className={`chip${method === "refund" ? " chip--on" : ""}`} onClick={() => setMethod("refund")}>Back to the card</button>
          <button type="button" role="radio" aria-checked={method === "credit"}
                  className={`chip${method === "credit" ? " chip--on" : ""}`} onClick={() => setMethod("credit")}>{creditLabel(rows)}</button>
          {!allCard && <InfoTip label="Why not to the card">Only invoices paid by card can go back to the card. Open ones and ones paid outside Stripe are credited.</InfoTip>}
        </div>

        <ul className="refund__rows" aria-label="Invoices">
          {rows.map((i) => {
            const err = bad(i);
            const id = `refund-amount-${i.invoiceId}`;
            const back = (Number(i.refundedSek) || 0) + (Number(i.creditedSek) || 0);
            return (
              <li key={i.invoiceId} className="refund__row">
                <div className="refund__head">
                  <strong className="mono">{i.number ?? i.invoiceId}</strong>
                  <span className="muted small">{i.periodStart ? `${fmtDay(i.periodStart)} to ${fmtDay(i.periodEnd)}` : fmtDay(i.createdAt)}</span>
                </div>
                <dl className="refund__facts">
                  <div><dt>{i.status === "paid" ? "Paid" : "Owed"}</dt><dd>{fmtSek(i.status === "paid" ? i.amountPaidSek : i.amountRemainingSek, { decimals: true })}</dd></div>
                  <div><dt>Already back</dt><dd>{back > 0 ? fmtSek(back, { decimals: true }) : "-"}</dd></div>
                </dl>
                <label className="field refund__amount" htmlFor={id}>
                  <span className="field__label">Amount incl VAT</span>
                  <span className="refund__input">
                    <input id={id} className="input mono" inputMode="decimal" autoComplete="off" value={amounts[i.invoiceId] ?? ""}
                           aria-label={`Amount for ${i.number ?? i.invoiceId}, incl VAT`}
                           aria-invalid={err ? true : undefined} aria-describedby={err ? `${id}-err` : undefined}
                           onChange={(e) => setAmounts((m) => ({ ...m, [i.invoiceId]: e.target.value }))} onBlur={() => cap(i)} />
                    <span className="muted">kr</span>
                  </span>
                  <span className="field__hint">Max {fmtSek(left(i), { decimals: true })}</span>
                  {err && <span id={`${id}-err`} className="field__hint error-text">{err}</span>}
                </label>
                {failed[i.invoiceId] && <div className="refund__failed small"><ErrorNotice error={failed[i.invoiceId]} /></div>}
              </li>
            );
          })}
        </ul>

        <div className="grid">
          <label className="field">
            <span className="field__label">Reason</span>
            <Select value={reason} onChange={setReason} options={REASONS} aria-label="Reason" />
          </label>
          <label className="field">
            <span className="field__label">Memo</span>
            <input className="input" maxLength={500} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="On the credit note" />
          </label>
        </div>

        <p className="refund__sum">
          <span>Total <strong>{fmtSek(total, { decimals: true })}</strong>{method === "refund" ? " back to the card" : " credited"}</span>
          <InfoTip label="Card fee">Stripe keeps its card fee.</InfoTip>
        </p>

        <ErrorNotice error={a.error} />
        <div className="row">
          <button type="button" className="btn btn--danger" disabled={invalid || a.busy || total <= 0} aria-busy={a.busy || undefined} onClick={() => void submit()}>
            {a.busy ? (method === "refund" ? "Refunding…" : "Crediting…") : `${verb} ${fmtSek(total, { decimals: true })}`}
          </button>
          <button type="button" className="btn btn--ghost" disabled={a.busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
