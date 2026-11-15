import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { APP_HINT_HREF, rememberDesktopHint, shouldShowDesktopHint } from "../desktopHint";
import { Icon } from "./ds";
import "./desktopHint.css";

/** Whether the desktop app note shows in this tab, and how to close it. Decided once per load. */
export function useDesktopHint(): [boolean, () => void] {
  const [show, setShow] = useState(shouldShowDesktopHint);
  useEffect(() => { if (show) rememberDesktopHint(); }, [show]);
  return [show, () => setShow(false)];
}

/**
 * The note itself, inline: at the bottom of the side menu on wide screens
 * (where="side") and as a card at the top of the page below that
 * (where="flow"). CSS shows one of the two.
 */
export function DesktopHint({ where, onClose }: { where: "side" | "flow"; onClose: () => void }) {
  return (
    <div className={`app-hint app-hint--${where}`}>
      <p className="app-hint__text">
        Want to see your desktop through the glass?{" "}
        <Link to={APP_HINT_HREF} onClick={onClose}>Download the app</Link>
      </p>
      <button type="button" className="app-hint__close" aria-label="Close" onClick={onClose}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
