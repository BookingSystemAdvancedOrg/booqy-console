import type { ReactNode } from "react";

/**
 * The name of a row that opens something in place, as a real button: it is
 * the row's tab stop and what screen readers announce. The row's own click
 * (rowAction) covers the rest of the row for mouse and touch.
 */
export function RowButton({ onClick, label, current, children }: {
  onClick: () => void;
  label?: string;
  current?: boolean;
  children: ReactNode;
}) {
  return (
    <button type="button" className="row-link__name row-link__btn" aria-label={label}
            aria-current={current ? "true" : undefined} onClick={onClick}>
      {children}
    </button>
  );
}
