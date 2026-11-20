import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { confirmLeave } from "./save";

const guard = (e: MouseEvent) => { if (!confirmLeave()) e.preventDefault(); };

/**
 * Phones: Mail, Reports and Notifications share the Inbox slot in the bottom bar, so both
 * pages open with this switch (glass chips, glide.ts). Hidden from 761 px,
 * where the side menu lists them.
 */
export function InboxSwitch({ on }: { on: "mail" | "reports" | "notifications" }) {
  return (
    <div className="chips inbox-switch" role="group" aria-label="Inbox">
      <Link to="/mail" className={`chip${on === "mail" ? " chip--on" : ""}`} aria-current={on === "mail" ? "page" : undefined} onClick={guard}>Mail</Link>
      <Link to="/reports" className={`chip${on === "reports" ? " chip--on" : ""}`} aria-current={on === "reports" ? "page" : undefined} onClick={guard}>Reports</Link>
      <Link to="/notifications" className={`chip${on === "notifications" ? " chip--on" : ""}`} aria-current={on === "notifications" ? "page" : undefined} onClick={guard}>Notifications</Link>
    </div>
  );
}
