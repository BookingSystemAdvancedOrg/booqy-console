import { useId } from "react";
import "./planFields.css";

/** A plan card's one line: Free has no charge, Starter one location, Growth several. */
export function planLine(p: { free?: boolean; maxLocations: number }): string {
  if (p.free) return "No charge";
  return p.maxLocations > 1 ? "Multiple locations" : "1 location";
}

/** Where the locations stepper starts on a plan: Free 1, else the plan's number. */
export const defaultLocations = (p: { free?: boolean; maxLocations: number }) => (p.free ? 1 : p.maxLocations);

export const MAX_LOCATIONS = 100;

/** Clamped to 1..100 whole locations. */
export const clampLocations = (n: number) => Math.min(MAX_LOCATIONS, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));

/** The number of locations the customer may have: minus, the number, plus. */
export function LocationStepper({ id, value, onChange, error, changed, hint }: {
  id?: string;
  value: number;
  onChange: (next: number) => void;
  error?: string;
  changed?: boolean;
  hint?: string;
}) {
  const labelId = useId();
  const msgId = useId();
  return (
    <div className={`field${error ? " field--error" : ""}${changed ? " field--changed" : ""}`} >
      <span id={labelId} className="field__label">Locations{changed && <span className="sr-only"> (changed)</span>}</span>
      <div className="stepper">
        <button type="button" className="stepper__btn" aria-label="Fewer locations" disabled={value <= 1}
                onClick={() => onChange(clampLocations(value - 1))}>−</button>
        <input id={id} className="input mono stepper__num" type="number" inputMode="numeric" min={1} max={MAX_LOCATIONS} step={1}
               aria-labelledby={labelId} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? msgId : undefined}
               value={value} onChange={(e) => onChange(clampLocations(Number(e.target.value)))} />
        <button type="button" className="stepper__btn" aria-label="More locations" disabled={value >= MAX_LOCATIONS}
                onClick={() => onChange(clampLocations(value + 1))}>+</button>
      </div>
      {error ? <span id={msgId} className="field__msg">{error}</span> : hint && <span id={msgId} className="field__hint">{hint}</span>}
    </div>
  );
}

/** Ticks every feature on, or all off when every one is on already. */
export function SelectAllFeatures({ keys, features, onChange }: {
  keys: string[];
  features: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
}) {
  const all = keys.length > 0 && keys.every((k) => features[k]);
  return (
    <button type="button" className="btn btn--ghost btn--small features__all"
            onClick={() => onChange(Object.fromEntries(keys.map((k) => [k, !all])))}>
      {all ? "Clear all" : "Select all"}
    </button>
  );
}
