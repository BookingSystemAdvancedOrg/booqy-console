import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * Unsaved changes and save feedback, the same on every form.
 *
 * useDirty compares the form with the last saved values, so undoing an edit
 * makes the form clean again. SaveButton is calm (disabled) while clean,
 * highlighted with a dot and "Unsaved changes" while dirty, keeps its busy
 * label while saving and shows a check and "Saved" for a moment after. A
 * dirty form registers here, so leaving the page (or a customer tab) asks
 * first.
 */

export const SAVED_MS = 1600;

/** JSON with sorted object keys: the same values in another order are equal. */
function stable(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

// ------------------------------------------------------------- leave guard
const pending = new Set<string>();
let listening = false;

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (pending.size === 0) return;
  e.preventDefault();
  e.returnValue = "";
}

/** True when nothing is unsaved, or the operator chose to leave anyway. */
export function confirmLeave(): boolean {
  if (pending.size === 0) return true;
  const ok = window.confirm("You have unsaved changes. Leave without saving?");
  if (ok) pending.clear();
  return ok;
}

/** Tests only. */
export function hasUnsaved(): boolean {
  return pending.size > 0;
}

/**
 * `current` is what the form holds now, `saved` what the server has. After a
 * successful save call markSaved() so the form is clean even before the
 * reload brings the new saved values.
 */
export function useDirty<T>(current: T, saved: T, opts: { guard?: boolean } = {}) {
  const guard = opts.guard ?? true;
  const savedKey = stable(saved);
  const currentKey = stable(current);
  const [mark, setMark] = useState<{ base: string; value: string } | null>(null);
  const baseline = mark && mark.base === savedKey ? mark.value : savedKey;
  const dirty = currentKey !== baseline;
  const base = useMemo(() => JSON.parse(baseline) as T, [baseline]);

  const id = useId();
  useEffect(() => {
    if (!guard || !dirty) return;
    if (!listening) {
      window.addEventListener("beforeunload", onBeforeUnload);
      listening = true;
    }
    pending.add(id);
    return () => { pending.delete(id); };
  }, [guard, dirty, id]);

  const changed = useCallback(
    (key: keyof T) => stable((current as Record<keyof T, unknown>)?.[key]) !== stable((base as Record<keyof T, unknown>)?.[key]),
    [current, base],
  );
  const markSaved = useCallback(() => setMark({ base: savedKey, value: currentKey }), [savedKey, currentKey]);
  return { dirty, changed, markSaved };
}

/** A flag that is on for a moment: the "Saved" check, a card's flash. */
export function useFlash(ms = SAVED_MS): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const fire = useCallback(() => {
    window.clearTimeout(timer.current);
    setOn(true);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, fire];
}

export function CheckMark() {
  return (
    <svg className="check-mark" viewBox="0 0 24 24" width={15} height={15} aria-hidden="true" focusable="false">
      <path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The button for a save or an action. `dirty` undefined: an action without a
 * form (always enabled, just busy and done). `dirty` false: a clean form, so
 * the button rests disabled. `allowClean` keeps it enabled while clean (a
 * "Save and retry" that also works with nothing changed).
 */
export function SaveButton(props: {
  label: string;
  busy?: boolean;
  done?: boolean;
  dirty?: boolean;
  busyLabel?: string;
  doneLabel?: string;
  disabled?: boolean;
  allowClean?: boolean;
  hint?: boolean;
  small?: boolean;
  kind?: "primary" | "ghost" | "danger" | "plain";
  type?: "submit" | "button";
  title?: string;
  autoFocus?: boolean;
  onClick?: () => void;
}) {
  const { busy, done, dirty, kind = "primary" } = props;
  const state = busy ? "busy" : done ? "done" : dirty ? "dirty" : dirty === false ? "clean" : "idle";
  const disabled = !!props.disabled || !!busy || (dirty === false && !props.allowClean && !done);
  const variant = kind === "plain" ? "" : ` btn--${kind}`;
  return (
    <span className="save">
      <button type={props.type ?? "submit"} className={`btn${variant}${props.small ? " btn--small" : ""} save-btn save-btn--${state}`}
              disabled={disabled} title={props.title} autoFocus={props.autoFocus}
              onClick={done ? (e) => e.preventDefault() : props.onClick}>
        {done ? <><CheckMark />{props.doneLabel ?? "Saved"}</>
          : busy ? props.busyLabel ?? "Saving…"
          : <>{dirty && <i className="save-btn__dot" aria-hidden="true" />}{props.label}</>}
      </button>
      <span className="save-hint" role="status" aria-live="polite">
        {dirty && !busy && !done && props.hint !== false ? "Unsaved changes" : ""}
      </span>
    </span>
  );
}

/** Refresh for any page: busy while it loads, "Up to date" when it worked. */
export function RefreshButton({ reload }: { reload: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const [done, flash] = useFlash();
  return (
    <SaveButton kind="ghost" type="button" label="Refresh" busy={busy} busyLabel="Refreshing…" done={done} doneLabel="Up to date"
                onClick={async () => {
                  setBusy(true);
                  const ok = await reload().finally(() => setBusy(false));
                  if (ok) flash();
                }} />
  );
}
