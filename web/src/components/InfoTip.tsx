import { ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./stepFlow.css";

/** A small "i" that shows its text on hover, focus or tap. */
export function InfoTip({ label, children, trigger, className }: {
  label: string; children: ReactNode;
  /** In place of the "i": what the button shows (a trend chip). Its own text names it, so no aria-label. */
  trigger?: ReactNode; className?: string;
}) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  // A tap sends hover and focus (they open the tip) right before the click: that click must not close it again.
  const openedAt = useRef(0);
  const show = () => { if (!open) openedAt.current = Date.now(); setOpen(true); };
  // The tip lives on <body> (fixed), so no card, scroll box or sticky bar can clip it. It sits to the
  // right of the dot when there is room, else below, else above, always kept inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btn.current?.getBoundingClientRect(), el = pop.current;
      if (!b || !el) return;
      const gap = 8, edge = 12, vw = window.innerWidth, vh = window.innerHeight;
      el.style.maxWidth = `${Math.min(320, vw - 2 * edge)}px`;
      const w = el.offsetWidth, h = el.offsetHeight;
      let left: number, top: number;
      if (b.right + gap + w <= vw - edge) {
        left = b.right + gap;
        top = Math.min(Math.max(edge, b.top + b.height / 2 - h / 2), vh - h - edge);
      } else {
        left = Math.min(Math.max(edge, b.left + b.width / 2 - w / 2), vw - w - edge);
        top = b.bottom + gap + h <= vh - edge ? b.bottom + gap : Math.max(edge, b.top - gap - h);
      }
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);
  return (
    <span className="info-tip" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      <button ref={btn} type="button" className={className ?? "info-tip__btn"} aria-label={trigger ? undefined : label}
              aria-describedby={trigger ? undefined : id} aria-expanded={open}
              onFocus={show} onBlur={() => setOpen(false)}
              onClick={() => { if (Date.now() - openedAt.current > 400) setOpen((o) => !o); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); (e.currentTarget as HTMLButtonElement).blur(); } }}>
        {trigger ?? (
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 11v6M12 7.2v.1" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        )}
      </button>
      {createPortal(
        <span ref={pop} id={id} role="tooltip" aria-hidden={trigger ? true : undefined} className={`info-tip__pop${open ? " is-open" : ""}`}>{children}</span>,
        document.body,
      )}
    </span>
  );
}
