import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Row actions in a table or list: quiet ghost buttons (className "row-action",
 * "row-action row-action--danger" for destructive ones). When the table is
 * narrow (container query on .table-wrap) they fold into a "…" menu. The
 * menu renders its buttons only while open, so they are never in the DOM twice.
 */
export function RowActions({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span className="row-actions-box" ref={box}>
      <span className="row-actions row-actions--inline">{children}</span>
      <span className="row-menu">
        <button type="button" className="row-action row-menu__toggle" aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">…</span>
        </button>
        {open && (
          <span className="row-menu__list" onClick={() => setOpen(false)}>
            {children}
          </span>
        )}
      </span>
    </span>
  );
}
