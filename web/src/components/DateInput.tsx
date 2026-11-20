import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import "./dateInput.css";

/* Dates as DD/MM/YYYY whatever the browser's language, with a Booqy-themed
   calendar (ported from admin src/shared/DateInput.tsx). A plain
   <input type="date"> shows the browser's format (MM/DD/YYYY in an English
   Chrome) and opens the operating system's picker.

   Values in and out match the native field: "YYYY-MM-DD", and "" while the
   text is empty, incomplete or outside min/max. onChange gets
   { target: { value } } so call sites read as before. MonthPicker is the
   month mode (value "YYYY-MM", like <input type="month">). */

type Change = (e: { target: { value: string } }) => void;

export type DateInputProps = {
  id?: string;
  value: string;
  onChange: Change;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  /** Classes for the text field; it always has "input". */
  className?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-describedby"?: string;
};

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function validIso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d > days ? null : isoOf(y, m, d);
}

/** "2026-10-22" -> "22/10/2026". */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** "22/10/2026" (also 22.10.2026, 2/3/2026, 22102026 and ISO) -> "2026-10-22", else null. */
export function parseDate(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return validIso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return validIso(+m[3], +m[2], +m[1]);
  m = /^(\d{2})(\d{2})(\d{4})$/.exec(t);
  return m ? validIso(+m[3], +m[2], +m[1]) : null;
}

/** Typing help: a slash after day and month, never two separators in a row. */
function maskDate(raw: string, prev: string): string {
  if (/^\d{4}-/.test(raw)) return raw.slice(0, 10);
  let t = raw.replace(/[.\-\s]/g, "/").replace(/[^\d/]/g, "").replace(/\/{2,}/g, "/");
  if (raw.length > prev.length && (/^\d{2}$/.test(t) || /^\d{1,2}\/\d{2}$/.test(t))) t += "/";
  return t.slice(0, 10);
}

function inRange(iso: string, min?: string, max?: string) {
  return (!min || iso >= min.slice(0, iso.length)) && (!max || iso <= max.slice(0, iso.length));
}

function todayIso() {
  const d = new Date();
  return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// One calendar at a time: a new one closes the one already open.
let closeOpen: (() => void) | null = null;

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

/** Escape on the field or its button while the calendar is open closes only the calendar, never a Modal around it. */
function closeOnEscape(e: KeyboardEvent<HTMLElement>, close: () => void) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  close();
}

/** Date as DD/MM/YYYY with a calendar (weeks start on Monday). */
export function DateInput({ value, onChange, min, max, className, ...rest }: DateInputProps) {
  const [text, setText] = useState(() => formatDate(value));
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useRef((refocus?: boolean) => { setOpen(false); if (refocus) button.current?.focus(); }).current;

  // Follow the value from outside (a preset, a reset) without overwriting what is being typed.
  useEffect(() => {
    const current = parseDate(text);
    if ((current && inRange(current, min, max) ? current : "") !== value) setText(formatDate(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function update(next: string) {
    const iso = parseDate(next);
    const ok = iso && inRange(iso, min, max) ? iso : "";
    setText(iso && /^\d{4}-/.test(next) ? formatDate(iso) : next);
    onChange({ target: { value: ok } });
  }

  const parsed = parseDate(text);
  const invalid = text !== "" && !(parsed && inRange(parsed, min, max));
  const ariaInvalid = rest["aria-invalid"] === true || rest["aria-invalid"] === "true" || invalid || undefined;

  return (
    <span className="date-input" ref={wrap}>
      <input
        ref={input}
        id={rest.id}
        className={`input ${className ?? ""}`.trim()}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="DD/MM/YYYY"
        value={text}
        disabled={rest.disabled}
        required={rest.required}
        aria-label={rest["aria-label"]}
        aria-invalid={ariaInvalid}
        aria-describedby={rest["aria-describedby"]}
        onChange={(e) => update(maskDate(e.target.value, text))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && e.altKey) { e.preventDefault(); setOpen(true); }
          else if (open) closeOnEscape(e, () => setOpen(false));
        }}
      />
      <button ref={button} type="button" className="date-input__btn" aria-label="Open calendar" aria-haspopup="dialog"
              aria-expanded={open} disabled={rest.disabled} onClick={() => setOpen((o) => !o)}
              onKeyDown={(e) => { if (open) closeOnEscape(e, () => setOpen(false)); }}>
        <CalendarIcon />
      </button>
      {open && (
        <Calendar
          anchor={wrap}
          selected={parsed && inRange(parsed, min, max) ? parsed : value || ""}
          min={min?.slice(0, 10)}
          max={max?.slice(0, 10)}
          onPick={(iso) => { update(formatDate(iso)); setOpen(false); input.current?.focus(); }}
          onClose={close}
        />
      )}
    </span>
  );
}

/* --- The floating panel (shared by the day and month calendars) ---------- */

function Panel({ anchor, onClose, label, className, onKeyDown, children }: {
  anchor: RefObject<HTMLElement | null>;
  onClose: (refocus?: boolean) => void;
  label: string;
  className: string;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);

  // Fixed under the field (above it when there is no room), in a portal so modals and tables never clip it.
  useLayoutEffect(() => {
    function place() {
      const a = anchor.current?.getBoundingClientRect();
      const h = panel.current?.offsetHeight ?? 320;
      const w = panel.current?.offsetWidth ?? 284;
      if (!a) return;
      const below = a.bottom + 6 + h <= window.innerHeight;
      setPos({
        top: below ? a.bottom + 6 : Math.max(8, a.top - 6 - h),
        left: Math.max(8, Math.min(a.left, window.innerWidth - w - 8)),
        up: !below,
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  // Focus the chosen day once the panel is placed (a hidden panel cannot take focus).
  const focused = useRef(false);
  useEffect(() => {
    if (!pos || focused.current) return;
    focused.current = true;
    panel.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  }, [pos]);

  useEffect(() => {
    closeOpen?.();
    const mine = () => onClose();
    closeOpen = mine;
    return () => { if (closeOpen === mine) closeOpen = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function outside(e: MouseEvent) {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !panel.current?.contains(t)) onClose();
    }
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [anchor, onClose]);

  return createPortal(
    <div ref={panel} className={`date-cal ${className}${pos?.up ? " date-cal--up" : ""}`} role="dialog" aria-label={label}
         style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
         onKeyDown={(e) => {
           if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(true); return; }
           onKeyDown?.(e);
         }}>
      {children}
    </div>,
    document.body,
  );
}

function Calendar({ anchor, selected, min, max, onPick, onClose }: {
  anchor: RefObject<HTMLSpanElement | null>;
  selected: string;
  min?: string;
  max?: string;
  onPick: (iso: string) => void;
  onClose: (refocus?: boolean) => void;
}) {
  const today = todayIso();
  const start = selected || (min && min > today ? min : max && max < today ? max : today);
  const [view, setView] = useState({ y: +start.slice(0, 4), m: +start.slice(5, 7) });
  const [focus, setFocus] = useState(start);
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>(`[data-iso="${focus}"]`)?.focus();
  }, [focus, view]);

  const first = new Date(Date.UTC(view.y, view.m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const daysIn = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => isoOf(view.y, view.m, i + 1))];
  const allowed = (iso: string) => inRange(iso, min, max);

  function shift(months: number) {
    const d = new Date(Date.UTC(view.y, view.m - 1 + months, 1));
    setView({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key];
    if (!step || !(e.target as HTMLElement).dataset.iso) return;
    e.preventDefault();
    const d = new Date(`${focus}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + step);
    setFocus(d.toISOString().slice(0, 10));
    setView({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  }

  return (
    <Panel anchor={anchor} onClose={onClose} label="Choose date" className="date-cal--days" onKeyDown={onKey}>
      <div className="date-cal__head">
        <button type="button" className="date-cal__nav" aria-label="Previous month" onClick={() => shift(-1)}>‹</button>
        <span className="date-cal__title" aria-live="polite">{MONTHS[view.m - 1]} {view.y}</span>
        <button type="button" className="date-cal__nav" aria-label="Next month" onClick={() => shift(1)}>›</button>
      </div>
      <div className="date-cal__grid" ref={grid}>
        {WEEKDAYS.map((w) => <span key={w} className="date-cal__wd" aria-hidden="true">{w}</span>)}
        {cells.map((iso, i) => iso ? (
          <button key={iso} type="button" data-iso={iso} tabIndex={iso === focus ? 0 : -1}
                  className={`date-cal__day${iso === selected ? " is-selected" : ""}${iso === today ? " is-today" : ""}`}
                  aria-label={`${+iso.slice(8)} ${MONTHS[view.m - 1]} ${view.y}`} aria-pressed={iso === selected}
                  disabled={!allowed(iso)} onClick={() => onPick(iso)}>
            {+iso.slice(8)}
          </button>
        ) : <span key={`e${i}`} />)}
      </div>
      <button type="button" className="date-cal__today" disabled={!allowed(today)} onClick={() => onPick(today)}>Today</button>
    </Panel>
  );
}

/* --- Month mode ------------------------------------------------------------ */

export type MonthPickerProps = {
  /** "YYYY-MM", like <input type="month">. */
  value: string;
  onChange: (month: string) => void;
  min?: string;
  max?: string;
  /** What the trigger shows (e.g. "November 2026"). */
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
};

/** A button that opens a Booqy-themed year of months; picks "YYYY-MM". */
export function MonthPicker({ value, onChange, min, max, children, className, ...rest }: MonthPickerProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useRef((refocus?: boolean) => { setOpen(false); if (refocus) button.current?.focus(); }).current;
  const label = rest["aria-label"] ?? "Month";
  return (
    <>
      <button ref={button} type="button" className={className} aria-haspopup="dialog" aria-expanded={open}
              aria-label={`${label}: ${monthWords(value)}`} onClick={() => setOpen((o) => !o)}
              onKeyDown={(e) => { if (open) closeOnEscape(e, () => setOpen(false)); }}>
        {children}
      </button>
      {open && (
        <MonthCalendar anchor={button} value={value} min={min} max={max} label={label} onClose={close}
                       onPick={(m) => { onChange(m); close(true); }} />
      )}
    </>
  );
}

function monthWords(ym: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : "";
}

function MonthCalendar({ anchor, value, min, max, label, onPick, onClose }: {
  anchor: RefObject<HTMLButtonElement | null>;
  value: string;
  min?: string;
  max?: string;
  label: string;
  onPick: (ym: string) => void;
  onClose: (refocus?: boolean) => void;
}) {
  const now = todayIso().slice(0, 7);
  const start = /^\d{4}-\d{2}$/.test(value) ? value : now;
  const [year, setYear] = useState(+start.slice(0, 4));
  const [focus, setFocus] = useState(start);
  const grid = useRef<HTMLDivElement>(null);
  const allowed = (ym: string) => inRange(ym, min?.slice(0, 7), max?.slice(0, 7));

  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>(`[data-ym="${focus}"]`)?.focus();
  }, [focus, year]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 } as Record<string, number>)[e.key];
    if (!step || !(e.target as HTMLElement).dataset.ym) return;
    e.preventDefault();
    const d = new Date(Date.UTC(+focus.slice(0, 4), +focus.slice(5, 7) - 1 + step, 1));
    const next = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    setFocus(next);
    setYear(d.getUTCFullYear());
  }

  return (
    <Panel anchor={anchor} onClose={onClose} label={`Choose ${label.toLowerCase()}`} className="date-cal--months" onKeyDown={onKey}>
      <div className="date-cal__head">
        <button type="button" className="date-cal__nav" aria-label="Previous year" onClick={() => setYear((y) => y - 1)}>‹</button>
        <span className="date-cal__title" aria-live="polite">{year}</span>
        <button type="button" className="date-cal__nav" aria-label="Next year" onClick={() => setYear((y) => y + 1)}>›</button>
      </div>
      <div className="date-cal__months" ref={grid}>
        {MONTHS_SHORT.map((short, i) => {
          const ym = `${year}-${pad(i + 1)}`;
          return (
            <button key={ym} type="button" data-ym={ym} tabIndex={ym === focus || (focus.slice(0, 4) !== String(year) && i === 0) ? 0 : -1}
                    className={`date-cal__day date-cal__month${ym === value ? " is-selected" : ""}${ym === now ? " is-today" : ""}`}
                    aria-label={`${MONTHS[i]} ${year}`} aria-pressed={ym === value}
                    disabled={!allowed(ym)} onClick={() => onPick(ym)}>
              {short}
            </button>
          );
        })}
      </div>
      <button type="button" className="date-cal__today" disabled={!allowed(now)} onClick={() => onPick(now)}>This month</button>
    </Panel>
  );
}
