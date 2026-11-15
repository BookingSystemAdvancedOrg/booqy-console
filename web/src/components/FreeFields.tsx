import { useId } from "react";
import { FREE_OPTIONS, FREE_PLAN_ID, type FreeForm, fmtFreeDay, freeLabel, isTimed } from "../free";
import type { Plan } from "../types";
import { Field } from "./ui";
import "./planFields.css";
import { Select } from "./Select";

/** The Free plan's period: free until changed, or 3 or 6 months and then
 * the plan and monthly price chosen here (both required). The end date is
 * the API's; `until` is the same date shown read only. */
export function FreeFields({ value, onChange, plans, until, errors = {}, changed = {}, price }: {
  value: FreeForm;
  onChange: (next: FreeForm) => void;
  plans: Plan[];
  /** The last free day as it will be saved (null = no end). */
  until: string | null;
  errors?: { preset?: string; thenPlanId?: string; price?: string };
  changed?: { preset?: boolean; thenPlanId?: boolean; price?: boolean };
  /** The monthly price after Free. */
  price: { value: string; onChange: (next: string) => void; id?: string };
}) {
  const paid = plans.filter((p) => p.planId !== FREE_PLAN_ID && !p.free);
  const timed = isTimed(value);
  const presetMsg = useId();
  return (
    <div className="free-fields" data-testid="free-fields">
      <div className="free-options" role="radiogroup" aria-label="Free period" id="f-free.preset"
           aria-describedby={errors.preset ? presetMsg : undefined} aria-invalid={errors.preset ? true : undefined}>
        {FREE_OPTIONS.map((o) => (
          <label key={o.id} className={`choice${value.preset === o.id ? " choice--on" : ""}`}>
            <input type="radio" name="free-preset" checked={value.preset === o.id}
                   onChange={() => onChange({ ...value, preset: o.id })} />
            <strong>{o.label}</strong>
            <span className="muted small">{o.sub}</span>
          </label>
        ))}
      </div>
      {errors.preset && <p id={presetMsg} className="field__msg free-until">{errors.preset}</p>}
      {timed && until && <p className="small muted free-until" data-testid="free-until">{freeLabel(until)}</p>}
      {timed && (
        <>
          <Field label="Then switch to" required error={errors.thenPlanId} changed={changed.thenPlanId}>
            <Select id="f-free.thenPlanId" required value={value.thenPlanId} placeholder="Choose a plan"
                    options={paid.map((p) => ({ value: p.planId, label: p.name }))}
                    onChange={(v) => onChange({ ...value, thenPlanId: v })} />
          </Field>
          <Field label="Monthly price after Free, SEK ex VAT" required error={errors.price} changed={changed.price}>
            <input id={price.id} className="input mono" type="number" min={1} step={1} inputMode="numeric" value={price.value}
                   onChange={(e) => price.onChange(e.target.value)} />
          </Field>
        </>
      )}
    </div>
  );
}

export function FreeBadge({ until }: { until?: string | null }) {
  return <span className="status status--free" title={until ? `Free until ${fmtFreeDay(until)}` : "Free, no end date"}>{freeLabel(until)}</span>;
}
