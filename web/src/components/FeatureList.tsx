import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FEATURE_HELP } from "../featureHelp";
import { exitMs } from "./motion";
import { FEATURE_LABELS, type FeatureKey } from "../contracts";
import "./featureList.css";

const label = (k: string) => (FEATURE_LABELS as Record<string, { en: string }>)[k]?.en ?? k;
const help = (k: string) => (FEATURE_HELP as Record<string, (typeof FEATURE_HELP)[FeatureKey] | undefined>)[k];

/**
 * The plan features as a stack: checkbox, name, one plain line, and a "?" that opens the
 * details with one example. One popover open at a time; it lives on <body> (fixed), so no
 * card, modal or scroll box clips it, and it flips above the row near the bottom edge.
 */
export function FeatureList({ keys, checked, onToggle, changed }: {
  keys: string[];
  checked: Record<string, boolean>;
  onToggle: (key: string, on: boolean) => void;
  /** Marks a row whose value differs from the saved one. */
  changed?: (key: string) => boolean;
}) {
  const base = useId();
  const [open, setOpen] = useState<string | null>(null);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const openRef = useRef<string | null>(null);
  openRef.current = open;
  const close = useCallback((refocus: boolean) => {
    const k = openRef.current;
    setOpen(null);
    if (k && refocus) buttons.current[k]?.focus();
  }, []);
  return (
    <ul className="feats">
      {keys.map((k) => {
        const h = help(k), name = label(k), nameId = `${base}-${k}-n`, lineId = `${base}-${k}-l`, popId = `${base}-${k}-p`;
        return (
          <li key={k} className={`feat${changed?.(k) ? " feat--changed" : ""}`}>
            <label className="feat__main">
              <input type="checkbox" className="feat__box" checked={!!checked[k]} aria-labelledby={nameId}
                     aria-describedby={h ? lineId : undefined} onChange={(e) => onToggle(k, e.target.checked)} />
              <span className="feat__text">
                <span id={nameId} className="feat__name">{name}</span>
                {h && <span id={lineId} className="feat__line">{h.line}</span>}
              </span>
            </label>
            {h && (
              <button ref={(el) => { buttons.current[k] = el; }} type="button" className="feat__help"
                      aria-label={`About ${name}`} aria-expanded={open === k} aria-controls={open === k ? popId : undefined}
                      aria-haspopup="dialog"
                      onClick={() => setOpen((cur) => (cur === k ? null : k))}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.6M12 16.9v.1" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
            {h && open === k && (
              <FeaturePopover id={popId} title={name} about={h.about} example={h.example}
                              anchor={buttons.current[k]} onClose={close} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The phone layout (phoneTargets.css, Select.tsx): the details open as a bottom sheet. */
const isPhone = () => { try { return window.matchMedia("(max-width: 640px)").matches; } catch { return false; } };

function FeaturePopover({ id, title, about, example, anchor, onClose: closeNow }: {
  id: string; title: string; about: string; example: string;
  anchor: HTMLButtonElement | null;
  onClose: (refocus: boolean) => void;
}) {
  const pop = useRef<HTMLDivElement>(null);
  const titleId = `${id}-t`;
  const sheet = isPhone();
  // The phone sheet slides away (180 ms, ease-in); the desktop popover closes at once (ux-motion #18).
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  const onClose = useCallback((refocus: boolean) => {
    const wait = sheet ? exitMs(180) : 0;
    if (wait === 0) { closeNow(refocus); return; }
    if (leaveTimer.current) return;
    setLeaving(true);
    leaveTimer.current = window.setTimeout(() => closeNow(refocus), wait);
  }, [sheet, closeNow]);
  useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (sheet || !anchor) return;   // phones: a bottom sheet, placed by CSS
    const place = () => {
      const b = anchor.getBoundingClientRect();
      const edge = 12, gap = 6, vw = document.documentElement.clientWidth || window.innerWidth, vh = window.innerHeight;
      // Up to 360 px, right edge at the "?", always inside the window.
      const width = Math.min(360, vw - 2 * edge);
      const left = Math.min(Math.max(edge, b.right - width), vw - width - edge);
      el.style.width = `${Math.round(width)}px`;
      el.style.left = `${Math.round(left)}px`;
      el.style.maxHeight = "";
      const h = el.scrollHeight;
      const below = vh - edge - (b.bottom + gap), above = b.top - gap - edge;
      let top: number;
      if (h <= below) top = b.bottom + gap;
      else if (h <= above) top = b.top - gap - h;
      else if (below >= above) { top = b.bottom + gap; el.style.maxHeight = `${Math.max(120, below)}px`; }
      else { const mh = Math.max(120, above); el.style.maxHeight = `${mh}px`; top = b.top - gap - mh; }
      el.style.top = `${Math.round(Math.max(edge, top))}px`;
      el.dataset.side = top >= b.bottom ? "below" : "above";
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [anchor, sheet]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || anchor?.contains(t)) return;
      // The scrim closes on its own click, so the tap never lands on a checkbox under it.
      if (t instanceof Element && t.classList.contains("feat-scrim")) return;
      onClose(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();   // an open popover in a modal closes first, not the modal
      onClose(true);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);
  return createPortal(
    <>
    {sheet && <div className="feat-scrim" aria-hidden="true" onClick={() => onClose(false)} data-closing={leaving || undefined} />}
    <div ref={pop} id={id} role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}
         className={`feat-pop${sheet ? " feat-pop--sheet" : ""}`} data-closing={leaving || undefined}
         onKeyDown={(e) => {
           // Nothing to tab to inside: Tab goes back to the "?" and closes.
           if (e.key === "Tab") { e.preventDefault(); onClose(true); }
         }}
         onBlur={(e) => {
           const to = e.relatedTarget as Node | null;
           if (to && !pop.current?.contains(to) && !anchor?.contains(to)) onClose(false);
         }}>
      {sheet && <div className="feat-pop__grip" aria-hidden="true" />}
      <p id={titleId} className="feat-pop__title">{title}</p>
      <p className="feat-pop__about">{about}</p>
      <p className="feat-pop__example"><span className="feat-pop__label">Example:</span> {example}</p>
    </div>
    </>,
    document.body,
  );
}
