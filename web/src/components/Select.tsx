import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./ds";
import "./select.css";

/* The console's dropdown: a select-only combobox (WAI-ARIA APG). The trigger
   is a button that keeps focus and points at the active option with
   aria-activedescendant; the list renders in a portal on body, under the
   trigger or above it when there is no room, and as a bottom sheet on phones.
   Never the operating system's menu. */

export type SelectOption = { value: string; label: string; disabled?: boolean };
export type SelectGroup = { label: string; options: SelectOption[] };
type Item = SelectOption | SelectGroup;

export type SelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: Item[];
  /** Shown when the value matches no option, e.g. "Choose a plan". */
  placeholder?: string;
  id?: string;
  /** Adds a hidden input so a plain form post carries the value. */
  name?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
};

const isGroup = (i: Item): i is SelectGroup => "options" in i;
const PHONE = "(max-width: 640px)";   // the phone layout (phoneTargets.css)
const GAP = 4, EDGE = 8, MAX_H = 320;

function isPhone(): boolean {
  try { return window.matchMedia(PHONE).matches; } catch { return false; }
}

export function Select(props: SelectProps) {
  const { value, onChange, options, placeholder, disabled, required, name, className = "", style, title } = props;
  const autoId = useId();
  const id = props.id ?? `sel${autoId}`;
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;
  const flat = useMemo(() => options.flatMap((o) => (isGroup(o) ? o.options : [o])), [options]);
  const selected = flat.findIndex((o) => o.value === value);

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [sheet, setSheet] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const [listName, setListName] = useState<string | undefined>();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const enabled = (i: number) => i >= 0 && i < flat.length && !flat[i].disabled;
  const step = useCallback((from: number, dir: 1 | -1, count = 1) => {
    let i = from, last = from, moved = 0;
    while (moved < count) {
      i += dir;
      if (i < 0 || i >= flat.length) break;
      if (!flat[i].disabled) { last = i; moved++; }
    }
    return last;
  }, [flat]);
  const first = () => step(-1, 1);
  const lastIdx = () => step(flat.length, -1);

  const show = (at?: number) => {
    if (disabled || flat.length === 0) return;
    const el = trigger.current;
    const label = props["aria-label"] ?? (el?.labels?.[0]?.querySelector(".field__label")?.textContent ?? el?.labels?.[0]?.textContent ?? undefined);
    setListName(label?.replace(/\s*\*\s*$/, "").trim() || undefined);
    setSheet(isPhone());
    setActive(at ?? (enabled(selected) ? selected : first()));
    setOpen(true);
    // Safari does not focus a clicked button: the keys must reach the trigger.
    if (document.activeElement !== el) el?.focus({ preventScroll: true });
  };
  const close = (focus = true) => {
    setOpen(false);
    typed.current.text = "";
    if (focus) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (i: number) => {
    if (!enabled(i)) return;
    close();
    if (flat[i].value !== value) onChange(flat[i].value);
  };

  // Typeahead: letters build a prefix for half a second; one repeated letter cycles.
  const typeahead = (ch: string): number => {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at > 500 ? ch : t.text + ch;
    t.at = now;
    const q = t.text.toLowerCase();
    const same = q.split("").every((c) => c === q[0]);
    const start = open ? active : selected;
    const order = flat.map((_, k) => (start + 1 + k) % flat.length);
    const hit = (s: string) => order.find((k) => enabled(k) && flat[k].label.toLowerCase().startsWith(s));
    const full = hit(q);
    // A longer prefix matches the current option too: stay on it.
    if (q.length > 1 && !same && start >= 0 && flat[start].label.toLowerCase().startsWith(q)) return start;
    return full ?? (same ? hit(q[0]) ?? -1 : -1);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const k = e.key;
    const printable = k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!open) {
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") { e.preventDefault(); show(); }
      else if (k === "Home") { e.preventDefault(); show(first()); }
      else if (k === "End") { e.preventDefault(); show(lastIdx()); }
      else if (printable) {
        e.preventDefault();
        const i = typeahead(k);
        show(i >= 0 ? i : undefined);
      }
      return;
    }
    switch (k) {
      case "ArrowDown": e.preventDefault(); setActive((a) => step(a, 1)); break;
      case "ArrowUp":
        e.preventDefault();
        if (e.altKey) choose(active); else setActive((a) => step(a, -1));
        break;
      case "PageDown": e.preventDefault(); setActive((a) => step(a, 1, 10)); break;
      case "PageUp": e.preventDefault(); setActive((a) => step(a, -1, 10)); break;
      case "Home": e.preventDefault(); setActive(first()); break;
      case "End": e.preventDefault(); setActive(lastIdx()); break;
      case "Enter": e.preventDefault(); choose(active); break;
      case " ":
        e.preventDefault();
        if (typed.current.text && Date.now() - typed.current.at < 500) { const i = typeahead(" "); if (i >= 0) setActive(i); }
        else choose(active);
        break;
      case "Escape": e.preventDefault(); e.stopPropagation(); close(); break;
      case "Tab": close(false); break;
      default:
        if (printable) { e.preventDefault(); const i = typeahead(k); if (i >= 0) setActive(i); }
    }
  };

  // Place the list: under the trigger, above when there is no room, inside the window.
  const place = useCallback(() => {
    const el = trigger.current, ul = list.current;
    if (!el || !ul || sheet) return;
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth, vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 240), vw - EDGE * 2);
    const left = Math.min(Math.max(r.left, EDGE), vw - width - EDGE);
    const want = Math.min(ul.scrollHeight || MAX_H, MAX_H);
    const below = vh - r.bottom - GAP - EDGE, above = r.top - GAP - EDGE;
    const up = below < want && above > below;
    const maxHeight = Math.max(Math.min(MAX_H, up ? above : below), 96);
    setPos(up ? { left, width, bottom: vh - r.top + GAP, maxHeight } : { left, width, top: r.bottom + GAP, maxHeight });
  }, [sheet]);

  useLayoutEffect(() => { if (open) place(); }, [open, place, flat.length]);

  // Keep the active option in view.
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const ul = list.current, li = document.getElementById(optId(active));
    if (!ul || !li) return;
    const top = li.offsetTop, bottom = top + li.offsetHeight;
    if (top < ul.scrollTop) ul.scrollTop = top;
    else if (bottom > ul.scrollTop + ul.clientHeight) ul.scrollTop = bottom - ul.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, pos]);

  // Outside click closes; a page scroll that moves the anchor closes; resize re-places.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (trigger.current?.contains(t) || list.current?.contains(t)) return;
      if (t instanceof Element && t.classList.contains("select-scrim")) return;   // its own click closes
      close(false);
    };
    const scroll = (e: Event) => {
      if (sheet) return;
      if (list.current && e.target instanceof Node && list.current.contains(e.target)) return;
      close(false);
    };
    const resize = () => place();
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet, place]);

  useEffect(() => { if (disabled && open) close(false); }, [disabled, open]);

  const shown = selected >= 0 ? flat[selected].label : placeholder ?? "";
  let n = -1;
  const renderOption = (o: SelectOption) => {
    const i = ++n;
    const isSel = i === selected;
    return (
      <div key={`${i}-${o.value}`} id={optId(i)} role="option" aria-selected={isSel} aria-disabled={o.disabled || undefined}
           className={`select-option${i === active ? " is-active" : ""}`}
           onMouseMove={() => { if (!o.disabled && i !== active) setActive(i); }}
           onClick={() => choose(i)}>
        <span className="select-option__label">{o.label}</span>
        {isSel && <Icon name="check" size={16} className="select-option__check" />}
      </div>
    );
  };

  return (
    <>
      <button ref={trigger} type="button" id={id} role="combobox" className={`input select ${className}`.trim()} style={style} title={title}
              aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
              aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
              aria-label={props["aria-label"]} aria-describedby={props["aria-describedby"]}
              aria-invalid={props["aria-invalid"] || undefined} aria-required={required || undefined}
              disabled={disabled} data-value={value}
              onClick={() => (open ? close() : show())} onKeyDown={onKeyDown}>
        <span className={`select__value${selected < 0 ? " select__value--empty" : ""}`}>{shown}</span>
        <Icon name="chevron-down" size={16} className="select__chevron" />
      </button>
      {name && <input type="hidden" name={name} value={value} />}
      {open && createPortal(
        <>
          {sheet && <div className="select-scrim" aria-hidden="true" onClick={() => close()} />}
          <div ref={list} id={listId} role="listbox" aria-label={listName} tabIndex={-1}
               className={`select-list${sheet ? " select-list--sheet" : ""}${pos.bottom !== undefined ? " select-list--up" : ""}`}
               style={sheet ? undefined : pos}
               onMouseDown={(e) => e.preventDefault()}>
            {sheet && <div className="select-list__grip" aria-hidden="true" />}
            {options.map((o, gi) => isGroup(o) ? (
              <div key={`g${gi}`} role="group" aria-labelledby={`${id}-g${gi}`} className="select-group">
                <div id={`${id}-g${gi}`} role="presentation" className="select-group__label">{o.label}</div>
                {o.options.map(renderOption)}
              </div>
            ) : renderOption(o))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
