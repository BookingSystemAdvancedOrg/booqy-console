import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api";
import { quietly, useLiveRefresh } from "../live";
import { useUnseenNotices } from "../notices";
import { Icon, type IconName } from "./ds";
import { MyAvatar } from "./MyAvatar";
import { confirmLeave } from "./save";
import { WorkspaceSheet } from "./WorkspaceSheet";
import { PHONE_NAV_QUERY, useKeyboardOpen, useMedia } from "./useKeyboardOpen";
import "./tabbar.css";

/** Slots that can be switched off (role gating); a hidden slot leaves no gap. */
export type TabSlot = "customers" | "inbox" | "new" | "finance" | "operators" | "website" | "settings";

/** The routes behind the Workspace (avatar) slot. */
export const WORKSPACE_PATHS = ["/operators", "/website", "/settings"];
/** Mail, Reports and Notifications are one Inbox slot. */
export const INBOX_PATHS = ["/mail", "/reports", "/notifications", "/outbox"];

const under = (path: string, roots: string[]) => roots.some((r) => path === r || path.startsWith(`${r}/`));

/** A dirty form asks before the bar takes the operator away (as the top bar does). */
const guard = (e: MouseEvent) => { if (!confirmLeave()) e.preventDefault(); };

/** Open reports, as a dot on Inbox (phones only: one quiet call per live pulse). */
function useOpenReports(enabled: boolean): boolean {
  const [open, setOpen] = useState(false);
  const load = useCallback(
    () => quietly(() => api.supportReports("open")).then((r) => setOpen((r?.items?.length ?? 0) > 0)),
    [],
  );
  useEffect(() => { if (enabled) void load().catch(() => {}); }, [enabled, load]);
  useLiveRefresh(load, { enabled });
  return open;
}

type Item = { slot: TabSlot; to: string; label: string; icon: IconName; end?: boolean; active?: boolean; className?: string; dot?: boolean };

/**
 * Phones (760 px and below): an iOS-style bar fixed at the bottom, icons
 * only, at most five targets. Customers, Inbox (Mail + Reports), the raised
 * New customer action, Finance, and your avatar, which opens the Workspace
 * sheet (profile, Operators, Website, Settings, Search, Sign out). Wider
 * screens keep the side menu and never show it (tabbar.css).
 */
export function TabBar(props: {
  name?: string;
  email?: string;
  username: string;
  profilePath: string;
  showInstall: boolean;
  showDownload: boolean;
  onSignOut: () => void;
  hidden?: TabSlot[];
}) {
  const { pathname } = useLocation();
  const phone = useMedia(PHONE_NAV_QUERY);
  useKeyboardOpen(phone);
  const [sheet, setSheet] = useState(false);
  const youRef = useRef<HTMLButtonElement>(null);
  const reports = useOpenReports(phone);
  const notices = useUnseenNotices(phone) > 0;
  const hide = new Set(props.hidden ?? []);
  const inboxOn = under(pathname, INBOX_PATHS);
  const youOn = under(pathname, WORKSPACE_PATHS) || pathname === props.profilePath;

  const left: Item[] = [
    { slot: "customers", to: "/", label: "Customers", icon: "users", end: true },
    { slot: "inbox", to: notices && !reports ? "/notifications" : "/mail",
      label: reports && notices ? "Inbox, open reports and notifications" : reports ? "Inbox, open reports" : notices ? "Inbox, new notifications" : "Inbox",
      icon: "mail", active: inboxOn, dot: reports || notices },
  ];
  const right: Item[] = [{ slot: "finance", to: "/finance", label: "Finance", icon: "chart" }];
  const centre: Item = { slot: "new", to: "/tenants/new", label: "New customer", icon: "plus", className: "tabbar__new" };

  const link = (it: Item) => {
    // Own active test (not NavLink's): Inbox also lights up on Reports and Outbox.
    const on = it.active ?? (it.end ? pathname === it.to : under(pathname, [it.to]));
    return (
      <Link
        key={it.slot}
        to={it.to}
        aria-label={it.label}
        title={it.label}
        data-help={`nav:${it.to}`}
        onClick={guard}
        className={`tabbar__item${it.className ? ` ${it.className}` : ""}${on ? " active" : ""}`}
        aria-current={on ? "page" : undefined}
      >
        <span className="tabbar__icon"><Icon name={it.icon} size={24} /></span>
        {it.dot && <span className="tabbar__dot" aria-hidden="true" />}
      </Link>
    );
  };

  // The Workspace sheet lists what is left of it; with all three hidden only
  // the profile, Search and Sign out remain, so the avatar always stays.
  const sheetHide = new Set(["operators", "website", "settings"].filter((s) => hide.has(s as TabSlot)));

  return (
    <>
      <nav className="tabbar" aria-label="Main">
        {left.filter((i) => !hide.has(i.slot)).map(link)}
        {!hide.has(centre.slot) && link(centre)}
        {right.filter((i) => !hide.has(i.slot)).map(link)}
        <button
          ref={youRef}
          type="button"
          className={`tabbar__item tabbar__you${youOn ? " active" : ""}`}
          aria-label="Workspace"
          title="Workspace"
          aria-haspopup="dialog"
          aria-expanded={sheet}
          aria-current={youOn ? "page" : undefined}
          onClick={() => setSheet((s) => !s)}
        >
          <span className="tabbar__icon"><MyAvatar name={props.name} email={props.email} size="md" /></span>
        </button>
      </nav>
      {sheet && (
        <WorkspaceSheet
          name={props.name}
          email={props.email}
          username={props.username}
          profilePath={props.profilePath}
          showInstall={props.showInstall}
          showDownload={props.showDownload}
          hidden={sheetHide}
          returnFocus={youRef}
          onClose={() => setSheet(false)}
          onSignOut={props.onSignOut}
        />
      )}
    </>
  );
}
