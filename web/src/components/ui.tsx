import { ReactNode, cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api";
import { CheckMark, useFlash } from "./save";

export function Field(props: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  wide?: boolean;
  /** Differs from the saved value: a light marker until saved or undone. */
  changed?: boolean;
}) {
  const msgId = useId();
  // One control inside: point it at the error (or hint) so screen readers read it with the field.
  const described = props.error || props.hint ? msgId : undefined;
  const control = isValidElement<Record<string, unknown>>(props.children)
    ? cloneElement(props.children, {
        "aria-invalid": props.error ? true : props.children.props["aria-invalid"],
        "aria-describedby": [props.children.props["aria-describedby"], described].filter(Boolean).join(" ") || undefined,
      })
    : props.children;
  return (
    <label className={`field${props.wide ? " field--wide" : ""}${props.error ? " field--error" : ""}${props.changed ? " field--changed" : ""}`}>
      <span className="field__label">
        {props.label}
        {props.required && <span className="field__req" aria-hidden> *</span>}
        {props.changed && <span className="sr-only"> (changed)</span>}
      </span>
      {control}
      {props.error ? <span id={msgId} className="field__msg">{props.error}</span>
        : props.hint && <span id={msgId} className="field__hint">{props.hint}</span>}
    </label>
  );
}

const STATUS_TEXT: Record<string, string> = {
  provisioning: "Setting up",
  provisioning_failed: "Setup failed",
  active: "Active",
  suspended: "Suspended",
  offboarding: "Offboarding",
  offboarded: "Offboarded",
  purged: "Data deleted",
  pending_dns: "Waiting for DNS",
  pending_validation: "Issuing certificate",
  validation_timeout: "DNS never appeared",
  failed: "Failed",
  removing: "Removing",
  registering: "Registering",
  awaiting_verification: "Waiting for .se verification",
  registered: "Registered",
  creating_zone: "Creating DNS zone",
  awaiting_nameservers: "Waiting for name servers",
  attaching: "Issuing certificates",
  live: "Live",
  slug_only: "Slug address only",
  not_mounted: "Not mounted yet",
  unknown: "Unknown",
  timed_out: "Timed out",
  transferring: "Transferring",
  transferred: "Transferred",
  sending: "Sending",
  sent: "Sent",
  partly_sent: "Partly sent",
  creating: "Setting up",
  simulated: "Dry run",
  ready: "Ready",
  archived: "Archived",
  deploying: "Deploying",
  cancelled: "Cancelled",
  none: "None",
};

export function Status({ value }: { value: string }) {
  return <span className={`status status--${value}`}>{STATUS_TEXT[value] ?? value}</span>;
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "ok" | "warn"; children: ReactNode }) {
  return <div className={`notice notice--${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

/** The loading state: a strip of receipt printing out. */
export function Printing({ label = "Loading", inline = false }: { label?: string; inline?: boolean }) {
  return (
    <div className={`printing${inline ? " printing--inline" : ""}`} role="status" aria-live="polite" aria-label={label}>
      <span className="printing__label">{label}</span>
      <i /><i /><i /><i />
    </div>
  );
}

/** What to show for any thrown value: our API's message, an Error's, or a
 * plain fallback; never "[object Object]" or a browser's "Failed to fetch". */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message || "Something went wrong. Try again.";
  if (error instanceof TypeError) return "Couldn't reach the API. Check your internet connection and try again.";
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong. Try again; if it keeps failing, reload the page.";
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <Notice kind="error">{errorMessage(error)}</Notice>;
}

/** After a save the API refused field by field: the first marked field gets focus, so the
 * operator fixes it and presses Save again. */
function focusFirstInvalid() {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>('.field--error input, .field--error select, .field--error textarea');
    el?.focus();
  });
}

/** `saved`: flash the card and stamp "Saved" in its head for a moment. */
export function Card(props: { title: string; actions?: ReactNode; children: ReactNode; tone?: "danger"; saved?: boolean; savedLabel?: string }) {
  return (
    <section className={`card${props.tone ? ` card--${props.tone}` : ""}${props.saved ? " card--saved" : ""}`}>
      <header className="card__head">
        <h2>{props.title}</h2>
        {(props.actions || props.saved) && (
          <div className="card__actions">
            {props.saved && <span className="saved-stamp" role="status"><CheckMark />{props.savedLabel ?? "Saved"}</span>}
            {props.actions}
          </div>
        )}
      </header>
      <div className="card__body">{props.children}</div>
    </section>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="modal" role="dialog" aria-modal aria-label={props.title} onMouseDown={props.onClose}>
      <div className={`modal__panel${props.wide ? " modal__panel--wide" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h3>{props.title}</h3>
          <button className="btn btn--ghost" onClick={props.onClose} aria-label="Close">✕</button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

/** Load-once data with reload(); errors kept for display. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async (): Promise<boolean> => {
    const id = ++latest.current;           // a slower, older response must not win
    try {
      const value = await load();
      if (id === latest.current) {
        setError(null);
        setData(value);
      }
      return true;
    } catch (e) {
      if (id === latest.current) setError(e);
      return false;
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, deps);
  useEffect(() => {
    setData(null);                         // never show the previous record's data
    setLoading(true);
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Wraps an action: busy flag, field errors, general error, and `done` for a moment after it worked. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [done, flash] = useFlash();
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const result = await fn();
      flash();
      return result;
    } catch (e) {
      setError(e);
      if (e instanceof ApiError) {
        setFields(e.fields);
        if (Object.keys(e.fields).length) focusFirstInvalid();
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [flash]);
  return { busy, error, fields, run, setError, done };
}

export function fmtDate(iso?: string) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("sv-SE", { dateStyle: "medium", timeStyle: "short" });
}

/** Drops empty strings so optional fields are omitted, not sent blank. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== "" && v !== undefined)) as Partial<T>;
}
