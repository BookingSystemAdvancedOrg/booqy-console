import { FREE_PLAN_ID, type FreeForm, defaultFreeUntil, earliestFreeUntil, fmtFreeDay, freeLabel } from "../free";
import type { Plan } from "../types";
import { Field } from "./ui";
import { fmtSek } from "../finance";

/** The Free plan's period: the last free day (three months by default),
 * "No end date", and the plan it switches to the day after. */
export function FreeFields({ value, onChange, plans, errors = {}, changed = {}, savedUntil }: {
  value: FreeForm;
  onChange: (next: FreeForm) => void;
  plans: Plan[];
  errors?: { until?: string; thenPlanId?: string };
  changed?: { until?: boolean; thenPlanId?: boolean };
  /** The last free day already saved: it may stay even when it is near. */
  savedUntil?: string | null;
}) {
  const paid = plans.filter((p) => p.planId !== FREE_PLAN_ID && !p.free);
  const then = paid.find((p) => p.planId === value.thenPlanId);
  const earliest = earliestFreeUntil();
  const min = savedUntil && savedUntil < earliest ? savedUntil : earliest;
  return (
    <div className="free-fields" data-testid="free-fields">
      <Field label="Free until" error={errors.until} changed={changed.until}
             hint={value.noEnd ? "Stays free until someone changes the plan" : `The last free day; ${then?.name ?? "the next plan"} from the day after`}>
        <input className="input" type="date" value={value.noEnd ? "" : value.until} min={min} disabled={value.noEnd}
               onChange={(e) => onChange({ ...value, until: e.target.value })} />
      </Field>
      <Field label="Then switch to" error={errors.thenPlanId} changed={changed.thenPlanId}
             hint={then?.priceSek != null ? `${fmtSek(then.priceSek)} per month ex VAT; the owner is emailed 14 days before` : undefined}>
        <select className="input" value={value.thenPlanId} disabled={value.noEnd}
                onChange={(e) => onChange({ ...value, thenPlanId: e.target.value })}>
          {paid.map((p) => <option key={p.planId} value={p.planId}>{p.name}</option>)}
        </select>
      </Field>
      <label className="check free-fields__noend">
        <input type="checkbox" checked={value.noEnd}
               onChange={(e) => onChange({ ...value, noEnd: e.target.checked, until: value.until || defaultFreeUntil() })} />
        No end date
      </label>
    </div>
  );
}

export function FreeBadge({ until }: { until?: string | null }) {
  return <span className="status status--free" title={until ? `Free until ${fmtFreeDay(until)}` : "Free, no end date"}>{freeLabel(until)}</span>;
}
