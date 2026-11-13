import { useNavigate } from "react-router-dom";
import type { KeyboardEvent, MouseEvent } from "react";

/**
 * Whole-row clicks for lists. A row with class "row-link" lights up on hover
 * (styles.css) and a click anywhere on it does what its name does. Clicks on
 * the row's own links and buttons, and text selection, are left alone; the
 * name stays a real link so keyboards and screen readers work as before.
 */
function ignore(e: MouseEvent): boolean {
  const target = e.target;
  // A click from a portal (a dialog, a lightbox) bubbles up the React tree
  // but is not inside the row on the page: never treat it as a row click.
  if (!(target instanceof Element) || !(e.currentTarget as Element).contains(target)) return true;
  return Boolean(target.closest("a, button, input, select, label, textarea, .row-actions-box, [data-row-stop]")) || Boolean(window.getSelection()?.toString());
}

/** For rows that open a page: Cmd or Ctrl opens it in a new tab, like a link. */
export function useRowOpen() {
  const navigate = useNavigate();
  return (e: MouseEvent, to: string) => {
    if (ignore(e)) return;
    if (e.metaKey || e.ctrlKey) window.open(to, "_blank", "noopener");
    else navigate(to);
  };
}

/**
 * For rows that open something in place (a modal, a reading pane): the click,
 * plus Enter and Space when the row has keyboard focus. Spread on the <tr>.
 */
export function rowAction(run: () => void) {
  return {
    tabIndex: 0,
    onClick: (e: MouseEvent) => { if (!ignore(e)) run(); },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      run();
    },
  };
}
