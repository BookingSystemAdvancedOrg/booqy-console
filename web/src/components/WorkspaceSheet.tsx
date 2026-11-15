import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, useLocation } from "react-router-dom";
import { emailName } from "../avatar";
import { Icon, openPalette, type IconName } from "./ds";
import { MyAvatar } from "./MyAvatar";
import { confirmLeave } from "./save";

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Outside the sheet while it is open: no clicks, no focus, hidden from screen readers. */
const BEHIND = [".topbar", ".main", ".tabbar", ".help-launcher"];

const guard = (e: MouseEvent) => { if (!confirmLeave()) e.preventDefault(); };

/**
 * Workspace: the avatar's bottom sheet on phones. Everything the old menu
 * drawer had that is not in the bar: your profile, Operators, Website,
 * Settings, Search, Install or Download app, and Sign out last. Closes on
 * Escape, a tap on the scrim, a swipe down and any page change; focus stays
 * inside while it is open and goes back to the avatar.
 */
export function WorkspaceSheet(props: {
  email?: string;
  username: string;
  profilePath: string;
  showInstall: boolean;
  showDownload: boolean;
  hidden: Set<string>;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const { onClose, returnFocus } = props;
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const opened = useRef(pathname);

  // A page change (a row here, the back button) closes it.
  useEffect(() => { if (pathname !== opened.current) onClose(); }, [pathname, onClose]);

  useEffect(() => {
    const behind = BEHIND.flatMap((s) => [...document.querySelectorAll<HTMLElement>(s)]);
    for (const el of behind) el.setAttribute("inert", "");
    const first = sheetRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus({ preventScroll: true });
    const back = returnFocus.current;
    const sheet = sheetRef.current;
    return () => {
      for (const el of behind) el.removeAttribute("inert");
      // Back to the avatar, unless something else took focus meanwhile (the Sign out dialog).
      const now = document.activeElement;
      if (!now || now === document.body || sheet?.contains(now)) back?.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key !== "Tab") return;
    const items = [...(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    // Moved by hand: Safari leaves links out of the Tab order, which would drop focus on the page body.
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  };

  // Swipe down to close: the sheet follows the finger; past 80 px or a quick flick it goes.
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const sheet = sheetRef.current;
    // From the grip and title anywhere; from the list only when it is not scrolled.
    const fromHead = !!(e.target as Element).closest(".ws-sheet__head");
    if (!sheet || (!fromHead && sheet.scrollTop > 0)) return;
    drag.current = { y: e.clientY, t: performance.now(), dy: 0 };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current, sheet = sheetRef.current;
    if (!d || !sheet) return;
    d.dy = Math.max(0, e.clientY - d.y);
    if (d.dy > 4) { sheet.classList.add("is-dragging"); sheet.style.transform = `translateY(${d.dy}px)`; }
  };
  const onPointerUp = () => {
    const d = drag.current, sheet = sheetRef.current;
    drag.current = null;
    if (!d || !sheet) return;
    sheet.classList.remove("is-dragging");
    const speed = d.dy / Math.max(1, performance.now() - d.t);
    if (d.dy > 80 || (d.dy > 24 && speed > 0.6)) onClose();
    else sheet.style.transform = "";
  };

  const row = (to: string, label: string, icon: IconName, help: string) => (
    <NavLink to={to} className="ws-row" data-help={help} onClick={guard}>
      <Icon name={icon} size={22} className="ws-row__icon" />
      <span className="ws-row__label">{label}</span>
    </NavLink>
  );
  const name = emailName(props.email) || props.username;

  return createPortal(
    <div className="ws-layer">
      <div className="ws-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={sheetRef}
        className="ws-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="ws-sheet__head">
          <span className="ws-sheet__grip" aria-hidden="true" />
          <h2 id={titleId} className="ws-sheet__title">Workspace</h2>
        </div>
        <Link to={props.profilePath} className="ws-row ws-row--me" onClick={guard}>
          <MyAvatar email={props.email} size="md" />
          <span className="ws-row__label">
            <span className="ws-row__name">{name}</span>
            <span className="ws-row__sub">My profile</span>
          </span>
          <Icon name="arrow-right" size={18} className="ws-row__chev" />
        </Link>
        <div className="ws-group">
          {!props.hidden.has("operators") && row("/operators", "Operators", "staff", "nav:/operators")}
          {!props.hidden.has("website") && row("/website", "Website", "globe", "nav:/website")}
          {!props.hidden.has("settings") && row("/settings", "Settings", "gear", "nav:/settings")}
        </div>
        <div className="ws-group">
          <button type="button" className="ws-row" onClick={() => { onClose(); openPalette(); }}>
            <Icon name="search" size={22} className="ws-row__icon" />
            <span className="ws-row__label">Search</span>
          </button>
          {/* To the Desktop app card in Settings, as the side menu does. */}
          {props.showInstall && (
            <Link to="/settings#desktop-app" className="ws-row" data-help="nav:/settings#desktop-app" onClick={guard}>
              <Icon name="download" size={22} className="ws-row__icon" />
              <span className="ws-row__label">Install app</span>
            </Link>
          )}
          {props.showDownload && (
            <Link to="/settings#desktop-app" className="ws-row" data-help="nav:/settings#desktop-app" onClick={guard}>
              <Icon name="download" size={22} className="ws-row__icon" />
              <span className="ws-row__label">Download app</span>
            </Link>
          )}
        </div>
        <div className="ws-group">
          <button type="button" className="ws-row ws-row--out" onClick={() => { onClose(); props.onSignOut(); }}>
            <Icon name="logout" size={22} className="ws-row__icon" />
            <span className="ws-row__label">Sign out</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
