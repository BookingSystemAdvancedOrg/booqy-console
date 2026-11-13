import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ButtonHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

/* The design-system pieces the console shares with admin (admin-front-end/src/shared):
   one stroke icon set, the command palette (Cmd/Ctrl+K), the primary CTA and the
   accordion. Styles in src/ds.css. */

export type IconName = "users" | "plus" | "terminal" | "badge" | "mail" | "chart" | "globe" | "gear" | "logout" | "search" | "send" | "chevron-down" | "arrow-right" | "close" | "menu" | "home" | "download" | "rotate";

// 24x24, 1.8 px stroke: the same drawings as admin's Icon.tsx.
const PATHS: Record<IconName, string> = {
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.2a5.5 5.5 0 0 1 3 5.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  terminal: '<rect x="6" y="3.5" width="12" height="17" rx="2"/><path d="M9 7.5h6M9 11.5h.01M12 11.5h.01M15 11.5h.01M9 15h.01M12 15h.01M15 15h.01"/>',
  badge: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M9.5 3v4h5V3M9 14.5a3 3 0 0 1 6 0M12 11.5h.01"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  chart: '<path d="M4 20h16M6.5 20v-6M11 20V9M15.5 20v-8M20 20V5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4L6 18M18 18l-1.6-1.6M7.6 7.6L6 6"/>',
  logout: '<path d="M14 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5H14M10 12h10M16.5 8.5L20 12l-3.5 3.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  send: '<path d="M20.5 3.5L3.5 10.8l6.6 2.6 2.6 6.6zM20.5 3.5l-10.4 9.9"/>',
  'chevron-down': '<path d="M6.5 9.5L12 15l5.5-5.5"/>',
  'arrow-right': '<path d="M4.5 12H19M13.5 6.5L19 12l-5.5 5.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H5.5A1.5 1.5 0 0 1 4 19z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/>',
  rotate: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.6h-4.6"/>',
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
         dangerouslySetInnerHTML={{ __html: PATHS[name] }} />
  );
}

/* --- Primary CTA ----------------------------------------------------------
   The page's one main button. On hover the label swaps for a short win phrase
   and the paper plane loops off to the upper right and back in; on mouse-out it
   finishes its loop and lands. Reduced motion: no flight, no slide (ds.css).
   Screen readers hear only the label. */
export function CtaButton({ label, win = "Kör!", className = "", onPointerEnter, onPointerLeave, ...rest }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { label: ReactNode; win?: string }) {
  const [flying, setFlying] = useState(false);
  const stopping = useRef(false);
  return (
    <button type="button" {...rest}
            className={`btn btn--primary cta${flying ? " is-flying" : ""} ${className}`.trim()}
            onPointerEnter={(e) => { if (e.pointerType === "mouse") { stopping.current = false; setFlying(true); } onPointerEnter?.(e); }}
            onPointerLeave={(e) => { stopping.current = true; onPointerLeave?.(e); }}>
      <span className="cta-plane" aria-hidden="true">
        <span className="cta-plane-fly" onAnimationIteration={() => { if (stopping.current) setFlying(false); }}>
          <Icon name="send" size={16} />
        </span>
      </span>
      <span className="cta-label">
        <span className="cta-text">{label}</span>
        <span className="cta-win" aria-hidden="true">{win}</span>
      </span>
    </button>
  );
}

/* --- Accordion --------------------------------------------------------------
   Rarely needed detail, folded away with a heading and a turning chevron.
   Closed unless told otherwise; a plain <details>, so keyboard and screen readers work. */
export function Disclosure({ title, meta, defaultOpen = false, className = "", children }:
  { title: ReactNode; meta?: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode }) {
  return (
    <details className={`ds-acc ${className}`.trim()} open={defaultOpen || undefined}>
      <summary className="ds-acc-head">
        <span className="ds-acc-title">{title}</span>
        {meta && <span className="ds-acc-meta">{meta}</span>}
        <Icon name="chevron-down" size={18} className="ds-acc-chevron" />
      </summary>
      <div className="ds-acc-body">{children}</div>
    </details>
  );
}

/* --- Command palette -----------------------------------------------------
   Cmd+K (Ctrl+K on Windows and Linux) or the search widget opens a centred
   glass dialog over a dimmed page: a focused input, grouped results
   (Actions, Go to, Recent), arrows to move, Enter to run, Esc to close. */
export type PaletteItem = { id: string; group: "Actions" | "Go to" | "Recent"; label: string; hint?: string; icon: IconName; keywords?: string; run: () => void };
const GROUPS: PaletteItem["group"][] = ["Actions", "Go to", "Recent"];
const OPEN_EVENT = "booqy:palette";

export function openPalette() { window.dispatchEvent(new Event(OPEN_EVENT)); }
export function paletteShortcut(): string {
  return /Mac|iPhone|iPad/.test(typeof navigator === "undefined" ? "" : navigator.userAgent) ? "⌘K" : "Ctrl K";
}
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function CommandPalette({ items }: { items: () => PaletteItem[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const baseId = useId();

  const show = useCallback(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery(""); setActive(0); setOpen(true);
  }, []);
  const close = useCallback(() => { setOpen(false); requestAnimationFrame(() => returnTo.current?.focus?.()); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); if (open) close(); else show(); }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_EVENT, show); };
  }, [open, show, close]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const html = document.documentElement; const prev = html.style.overflow; html.style.overflow = "hidden";
    return () => { html.style.overflow = prev; };
  }, [open]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => (open ? items() : []), [open]);
  const results = useMemo(() => {
    const q = fold(query.trim());
    const hit = q ? all.filter((i) => fold(`${i.label} ${i.hint ?? ""} ${i.keywords ?? ""}`).includes(q)) : all;
    return GROUPS.flatMap((g) => hit.filter((i) => i.group === g));
  }, [all, query]);
  const current = Math.min(active, Math.max(results.length - 1, 0));
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [current, results]);

  if (!open) return null;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const run = (item: PaletteItem | undefined) => { if (!item) return; setOpen(false); returnTo.current = null; item.run(); };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = results.length;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(n ? (current + 1) % n : 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(n ? (current - 1 + n) % n : 0); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(Math.max(n - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(results[current]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") e.preventDefault();
  };

  let index = -1;
  return createPortal(
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands" onKeyDown={onKeyDown}>
        <div className="palette-search">
          <Icon name="search" size={18} />
          <input ref={inputRef} className="palette-input" type="text" role="combobox" aria-expanded="true"
                 aria-controls={`${baseId}-list`} aria-activedescendant={results.length ? optionId(current) : undefined}
                 aria-autocomplete="list" autoComplete="off" spellCheck={false} placeholder="Search pages and actions"
                 value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
          <kbd className="palette-kbd">Esc</kbd>
        </div>
        <div className="palette-list" id={`${baseId}-list`} role="listbox" aria-label="Results" ref={listRef}>
          {results.length === 0 && <p className="palette-empty">Nothing matches “{query.trim()}”.</p>}
          {GROUPS.map((group, g) => {
            const inGroup = results.filter((r) => r.group === group);
            if (!inGroup.length) return null;
            const headId = `${baseId}-g${g}`;
            return (
              <div key={group} role="group" aria-labelledby={headId} className="palette-group">
                <p className="palette-group-label" id={headId}>{group}</p>
                {inGroup.map((item) => {
                  index += 1; const i = index;
                  return (
                    <div key={item.id} id={optionId(i)} role="option" aria-selected={i === current} className="palette-option"
                         onMouseMove={() => i !== current && setActive(i)} onClick={() => run(item)}>
                      <span className="palette-option-icon" aria-hidden="true"><Icon name={item.icon} size={18} /></span>
                      <span className="palette-option-label">{item.label}</span>
                      {item.hint && <span className="palette-option-hint">{item.hint}</span>}
                      <Icon name="arrow-right" size={16} className="palette-option-go" />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <p className="palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span>
        </p>
      </div>
    </div>,
    document.body,
  );
}

export function PaletteTrigger() {
  return (
    <button type="button" className="palette-trigger" onClick={openPalette} aria-label={`Search (${paletteShortcut()})`}>
      <Icon name="search" size={16} />
      <span className="palette-trigger-text">Search</span>
      <kbd className="palette-trigger-kbd">{paletteShortcut()}</kbd>
    </button>
  );
}
