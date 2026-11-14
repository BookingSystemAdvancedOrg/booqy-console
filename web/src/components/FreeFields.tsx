import { useState } from "react";
import { FREE_PLAN_ID, FREE_PRESETS, type FreeForm, applyFreePreset, earliestFreeUntil, fmtFreeDay, freeLabel, freePresetOf } from "../free";
import type { Plan } from "../types";
import { Field } from "./ui";
import { fmtSek } from "../finance";

/** The Free plan's period: 3 months (default), 6 months, no end date or a
 * date of your own; the plan it switches to the day after, and (when
 * `price` is given) the operator's own monthly price after Free, the plan's
 * by default. When it ends the customer rolls over to that price
 * automatically, 14 days after the owner was told. */
export function FreeFields({ value, onChange, plans, errors = {}, changed = {}, savedUntil, price }: {
  value: FreeForm;
  onChange: (next: FreeForm) => void;
  plans: Plan[];
  errors?: { until?: string; thenPlanId?: string; price?: string };
  changed?: { until?: boolean; thenPlanId?: boolean; price?: boolean };
  /** The last free day already saved: it may stay even when it is near. */
  savedUntil?: string | null;
  /** The price after Free: "" = the plan's. */
  price?: { value: string; onChange: (next: string) => void; id?: string };
}) {
  const paid = plans.filter((p) => p.planId !== FREE_PLAN_ID && !p.free);
  const then = paid.find((p) => p.planId === value.thenPlanId);
  const earliest = earliestFreeUntil();
  const min = savedUntil && savedUntil < earliest ? savedUntil : earliest;
  const preset = freePresetOf(value);
  const [custom, setCustom] = useState(preset === "custom");
  const shown = custom && !value.noEnd ? "custom" : preset;
  const shownPrice = price ? (price.value !== "" ? price.value : then?.priceSek != null ? String(then.priceSek) : "") : "";
  return (
    <div className="free-fields" data-testid="free-fields">
      <div className="field" style={{ gridColumn: "1 / -1" }}>
        <span className="field__label">Free for</span>
        <div className="chips" role="radiogroup" aria-label="Free for">
          {FREE_PRESETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={shown === p.id}
                    className={`chip${shown === p.id ? " chip--on" : ""}`}
                    onClick={() => { setCustom(p.id === "custom"); onChange(applyFreePreset(value, p.id)); }}>
              {p.label}
            </button>
          ))}
        </div>
        <span className="field__hint">
          {value.noEnd ? "Stays free until someone changes the plan" : `Free to ${fmtFreeDay(value.until)}; ${then?.name ?? "the next plan"} from the day after, invoiced at once for the rest of that month`}
        </span>
      </div>
      {shown === "custom" && (
        <Field label="Free until" error={errors.until} changed={changed.until} hint="The last free day">
          <input className="input" type="date" value={value.until} min={min}
                 onChange={(e) => onChange({ ...value, until: e.target.value })} />
        </Field>
      )}
      {!value.noEnd && errors.until && shown !== "custom" && <p className="field__msg">{errors.until}</p>}
      <Field label="Then switch to" error={errors.thenPlanId} changed={changed.thenPlanId}
             hint={then?.priceSek != null ? `Plan price ${fmtSek(then.priceSek)} per month ex VAT; the owner is emailed 14 days before` : undefined}>
        <select className="input" value={value.thenPlanId} disabled={value.noEnd}
                onChange={(e) => onChange({ ...value, thenPlanId: e.target.value })}>
          {paid.map((p) => <option key={p.planId} value={p.planId}>{p.name}</option>)}
        </select>
      </Field>
      {price && (
        <Field label="Price after Free, SEK ex VAT" error={errors.price} changed={changed.price}
               hint={value.noEnd ? "Used if an end date is set later" : "Charged automatically from the first paid day, pro rata for that month"}>
          <input id={price.id} className="input mono" type="number" min={0} step={1} value={shownPrice}
                 onChange={(e) => price.onChange(e.target.value)} />
        </Field>
      )}
    </div>
  );
}

export function FreeBadge({ until }: { until?: string | null }) {
  return <span className="status status--free" title={until ? `Free until ${fmtFreeDay(until)}` : "Free, no end date"}>{freeLabel(until)}</span>;
}
