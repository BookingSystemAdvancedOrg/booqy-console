import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import "./saveBar.css";

/**
 * Unsaved changes and save feedback, the same on every form.
 *
 * useDirty compares the form with the last saved values, so undoing an edit
 * makes the form clean again. SaveButton is calm (disabled) while clean,
 * highlighted with a dot and "Unsaved changes" while dirty, keeps its busy
 * label while saving and shows a check and "Saved" for a moment after. A
 * dirty form registers here, so leaving the page (or a customer tab) asks
 * first. SaveBar is the row every editable form ends with: it follows the
 * screen (sticky) while something is unsaved, with "Discard changes".
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
/** One reload the operator already confirmed (the update notice): let it through. */
let bypass = false;

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (bypass || pending.size === 0) return;
  e.preventDefault();
  e.returnValue = "";
}

/** True when nothing is unsaved, or the operator chose to leave anyway. */
export function confirmLeave(): boolean {
  if (pending.size === 0) return true;
  // The forms stay registered: a form that is still mounted keeps guarding.
  return window.confirm("You have unsaved changes. Leave without saving?");
}

/**
 * Lets the next unload through without asking, for a reload the operator has
 * already confirmed elsewhere (the update notice's "Reload anyway"). The
 * desktop app would otherwise cancel that reload silently. The dirty forms
 * stay registered, so hasUnsaved() and confirmLeave() stay right.
 */
export function discardUnsaved(): void {
  bypass = true;
}

/** Turns the guard back on when that reload did not happen. */
export function restoreUnsaved(): void {
  bypass = false;
}

/** True while a dirty form guards the page (the update notice asks first). */
export function hasUnsaved(): boolean {
  return pending.size > 0;
}

/**
 * `current` is what the form holds now, `saved` what the server has. After a
 * successful save call markSaved() so the form is clean even before the
 * reload brings the new saved values. `base` is the saved state the form is
 * compared with (a copy): Discard is `setF(dirty.base)`.
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
  return { dirty, changed, markSaved, base };
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
  form?: string;
  onClick?: () => void;
}) {
  const { busy, done, dirty, kind = "primary" } = props;
  const state = busy ? "busy" : done ? "done" : dirty ? "dirty" : dirty === false ? "clean" : "idle";
  const disabled = !!props.disabled || !!busy || (dirty === false && !props.allowClean && !done);
  const variant = kind === "plain" ? "" : ` btn--${kind}`;
  return (
    <span className="save">
      <button type={props.type ?? "submit"} className={`btn${variant}${props.small ? " btn--small" : ""} save-btn save-btn--${state}`}
              disabled={disabled} title={props.title} autoFocus={props.autoFocus} form={props.form}
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

/**
 * The save row every editable form ends with (owner 2026-11-18, the same as
 * the admin app's SaveBar):
 *
 * - Clean: rests in place at the end of the form, Save disabled.
 * - Dirty: follows the screen at the bottom of its form or card (sticky glass
 *   pill, above the phone's bottom bar; Ask Booqy lifts itself above it,
 *   features/help/dodge.ts) with "Unsaved changes" and "Discard changes".
 *   Changing everything back makes it clean again.
 * - Failed (`failed`): the changes stay, the page goes to the field marked
 *   invalid (or the error note) and Save reads "Save and retry".
 *
 * Without `onSave` the button submits the enclosing form (or `form`).
 * `onCancel` (a form opened with Edit): a Cancel that shows while clean;
 * while dirty "Discard changes" takes its place.
 */
export function SaveBar(props: {
  dirty: boolean;
  label?: string;
  busy?: boolean;
  done?: boolean;
  busyLabel?: string;
  doneLabel?: string;
  onSave?: () => void;
  onDiscard?: () => void;
  onCancel?: () => void;
  failed?: boolean;
  disabled?: boolean;
  allowClean?: boolean;
  title?: string;
  form?: string;
  /** More buttons at the start of the row (secondary, ghost). */
  children?: ReactNode;
}) {
  const { dirty, busy, failed } = props;
  const ref = useRef<HTMLDivElement>(null);

  // A failed save: to the field marked invalid, else to the error note.
  useEffect(() => {
    if (!failed) return;
    const scope: ParentNode = (props.form && document.getElementById(props.form)) || ref.current?.closest("form, .card, .modal__panel") || document;
    const field = scope.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = field ?? scope.querySelector<HTMLElement>(".notice--error, .field__msg, [role=alert]");
    if (!target) return;
    target.scrollIntoView?.({ block: "center", behavior: "smooth" });
    if (field) field.focus({ preventScroll: true });
  }, [failed, props.form]);

  return (
    <div ref={ref} className={`save-bar${dirty ? " save-bar--dirty" : ""}`} data-testid="save-bar">
      <span className="save-bar__status" role="status" aria-live="polite">
        {dirty && !busy && <><i className="save-bar__dot" aria-hidden="true" />Unsaved changes</>}
      </span>
      {props.children}
      {dirty && props.onDiscard && (
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={props.onDiscard}>Discard changes</button>
      )}
      {!dirty && props.onCancel && (
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={props.onCancel}>Cancel</button>
      )}
      <SaveButton label={failed && dirty ? "Save and retry" : props.label ?? "Save"} busy={busy} done={props.done}
                  busyLabel={props.busyLabel} doneLabel={props.doneLabel} dirty={dirty} disabled={props.disabled}
                  allowClean={props.allowClean} hint={false} title={props.title}
                  type={props.onSave ? "button" : "submit"} onClick={props.onSave} form={props.form} />
    </div>
  );
}
