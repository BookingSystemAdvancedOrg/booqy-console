import { Fragment, StrictMode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { currentOperator, onAuthChange, retryUntilReachable, signOut, type Operator } from "./auth";
import "./connectionNotice.css";
import LoginPage, { RESET_PATH } from "./pages/LoginPage";
import { Logo } from "./components/Logo";
import { Modal } from "./components/ui";
import { installPress } from "./press";
import { BusyBar } from "./components/BusyBar";
import { confirmLeave, discardUnsaved, hasUnsaved } from "./components/save";
import { installGlide } from "./glide";
import { installGlassFilter } from "./glassFilter";
import { installDesktopGlass } from "./desktopGlass";
import { syncBackdropImage } from "./backdropStore";
import { MyAvatar } from "./components/MyAvatar";
import { startUpdateNotice } from "./updateNotice";
import { showDownloadNav } from "./desktopDownloads";
import { DownloadRedirect } from "./components/DownloadRedirect";
import { installPwa, showPhoneInstallNav } from "./pwa";
import "@booqy/brand/styles.css";
import "./styles.css";
import "./ds.css";
import { CommandPalette, Icon, PaletteTrigger, type IconName, type PaletteItem } from "./components/ds";
import { SkelCard, SkelKpis, SkelPage, SkelShell } from "./components/Skeleton";
import { HelpChat } from "./features/help/HelpChat";
import { helpChatEnabled, openHelpChat } from "./features/help/chatState";

// Each page loads when it is opened, so the first load only fetches the shell
// and the page in view; the rest follow in the background once signed in.
const pages = {
  tenants: () => import("./pages/TenantsPage"),
  newTenant: () => import("./pages/NewTenantPage"),
  tenant: () => import("./pages/TenantPage"),
  operators: () => import("./pages/OperatorsPage"),
  mail: () => import("./pages/MailPage"),
  finance: () => import("./pages/FinancePage"),
  website: () => import("./pages/WebsitePage"),
  settings: () => import("./pages/SettingsPage"),
};
const TenantsPage = lazy(pages.tenants);
const NewTenantPage = lazy(pages.newTenant);
const TenantPage = lazy(pages.tenant);
const OperatorsPage = lazy(pages.operators);
const MailPage = lazy(pages.mail);
const FinancePage = lazy(pages.finance);
const WebsitePage = lazy(pages.website);
const SettingsPage = lazy(pages.settings);

let preloaded = false;
function preloadPages() {
  if (preloaded) return;
  preloaded = true;
  const run = () => { for (const load of Object.values(pages)) void load().catch(() => {}); };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}

installPress();
installGlide();
installGlassFilter();
installDesktopGlass();
// Installable on phones: service worker and the install button (built app only).
if (import.meta.env.PROD) installPwa();
// "A new version is available" after a deploy (built app only, not npm run dev).
if (import.meta.env.PROD) {
  startUpdateNotice({
    labels: {
      text: "A new version is available", reload: "Reload", reloading: "Reloading", later: "Not now",
      hint: "Loads the new version. Save what you are working on first.",
      unsaved: "You have unsaved changes", reloadAnyway: "Reload anyway", cancel: "Cancel",
      failed: "Could not reload. Try again.", updated: "Updated",
    },
    hasUnsaved,
    discardUnsaved,
  });
}

// Production is the default and is never labelled; only dev says so.
const IS_DEV = (import.meta.env.VITE_ENVIRONMENT ?? "dev") === "dev";

// The side menu: short groups, one icon each from the shared stroke set. The
// command palette's "Go to" is the same list.
type NavItem = { to: string; label: string; icon: IconName; end?: boolean };
const NAV: { label: string; items: NavItem[] }[] = [
  { label: "Restaurants", items: [
    { to: "/", label: "Customers", icon: "users", end: true },
    { to: "/tenants/new", label: "New customer", icon: "plus" },
  ] },
  { label: "Platform", items: [
    { to: "/operators", label: "Operators", icon: "staff" },
    { to: "/mail", label: "Mail", icon: "mail" },
  ] },
  { label: "Numbers", items: [
    { to: "/finance", label: "Finance", icon: "chart" },
    { to: "/website", label: "Website", icon: "globe" },
  ] },
];
// "Download app" only in a desktop browser: not inside the desktop app, not on phones.
const SHOW_DOWNLOAD = showDownloadNav();
// "Install app" on phones and tablets in the browser (home screen app, not yet installed).
const SHOW_INSTALL = showPhoneInstallNav();
const ALL_NAV: NavItem[] = [
  ...NAV.flatMap((g) => g.items),
  { to: "/settings", label: "Settings", icon: "gear" },
  ...(SHOW_DOWNLOAD ? [{ to: "/settings#desktop-app", label: "Download app", icon: "download" as const }] : []),
  ...(SHOW_INSTALL ? [{ to: "/settings#desktop-app", label: "Install app", icon: "download" as const }] : []),
];
const navFor = (path: string) => ALL_NAV.find((n) => (n.end ? path === n.to : path === n.to || path.startsWith(`${n.to}/`)));

// Pages visited in this tab (memory only): the palette's "Recent".
let recent: string[] = [];

function ConsolePalette({ onSignOut }: { onSignOut: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => { recent = [pathname, ...recent.filter((p) => p !== pathname)].slice(0, 6); }, [pathname]);
  const go = useCallback((to: string) => { if (confirmLeave()) navigate(to); }, [navigate]);
  const items = useCallback((): PaletteItem[] => {
    const here = window.location.pathname;
    const seen = new Set<string>();
    return [
      { id: "a-new", group: "Actions", label: "New customer", icon: "plus", keywords: "tenant restaurant onboard", run: () => go("/tenants/new") },
      { id: "a-outbox", group: "Actions", label: "Outbox", hint: "Mail", icon: "mail", keywords: "sent email", run: () => go("/outbox") },
      ...(helpChatEnabled() ? [{ id: "a-help", group: "Actions" as const, label: "Ask the help assistant", icon: "search" as const, keywords: "help assistant question how ask booqy", run: openHelpChat }] : []),
      { id: "a-signout", group: "Actions", label: "Sign out", icon: "logout", run: onSignOut },
      ...ALL_NAV.map((n): PaletteItem => ({ id: `n-${n.to}`, group: "Go to", label: n.label, icon: n.icon, run: () => go(n.to) })),
      ...recent
        .filter((p) => p !== here)
        .map(navFor)
        .filter((n): n is NavItem => !!n && !seen.has(n.to) && !!seen.add(n.to))
        .slice(0, 4)
        .map((n): PaletteItem => ({ id: `r-${n.to}`, group: "Recent", label: n.label, icon: n.icon, run: () => go(n.to) })),
    ];
  }, [go, onSignOut]);
  return <CommandPalette items={items} />;
}

function Shell() {
  const location = useLocation();
  const [user, setUser] = useState<Operator | null | undefined>(undefined);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // Phones: the links sit behind a Menu button. The menu belongs to the page
  // it was opened on, so going to another page closes it.
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const menuOpen = menuAt === location.pathname;
  // Cognito unreachable (offline, waking from sleep, an outage): still signed
  // in, the current page stays and the check runs again until it answers.
  const [offline, setOffline] = useState(false);
  const refresh = useCallback(() => {
    currentOperator().then(
      (u) => {
        setOffline(false);
        setUser(u);
      },
      () => setOffline(true),
    );
  }, []);
  useEffect(() => {
    refresh();
    return onAuthChange(refresh);           // sign-out, failed token refresh, 401 from the API
  }, [refresh]);
  useEffect(() => (offline ? retryUntilReachable(refresh) : undefined), [offline, refresh]);
  const notice = offline ? <div className="connection-notice" role="status" aria-live="polite">Can't reach the server, retrying...</div> : null;

  useEffect(() => {
    if (user) preloadPages();
  }, [user]);

  // Your own picture behind the glass: fetched once signed in (backdropStore.ts).
  useEffect(() => {
    if (user) syncBackdropImage();
  }, [user]);

  // The emailed reset link works signed in or out (LoginPage signs out
  // once the new password is set).
  if (location.pathname === RESET_PATH) return <LoginPage onSignedIn={refresh} />;
  if (user === undefined) return <>{notice}<SkelShell label="Signing in" /></>;
  if (!user) return <LoginPage onSignedIn={refresh} />;

  return (
    <div className="app">
      {notice}
      {/* A dirty form asks before any top bar link takes the operator away. */}
      <header className={menuOpen ? "topbar is-open" : "topbar"} onClickCapture={(e) => { if ((e.target as HTMLElement).closest("a[href]") && !confirmLeave()) e.preventDefault(); }}>
        <Link to="/" className="brand" aria-label="Booqy Console - customers"><Logo className="brand__logo" /><span className="brand__app">Console</span></Link>
        {IS_DEV && <span className="env">dev</span>}
        <PaletteTrigger />
        <button
          type="button"
          className="topbar__menu"
          aria-expanded={menuOpen}
          aria-controls="topbar-menu"
          aria-label={menuOpen ? "Close menu" : "Menu"}
          onClick={() => setMenuAt(menuOpen ? null : location.pathname)}
        >
          <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
        </button>
        <nav className="topbar__nav" id="topbar-menu">
          {/* The headings only show in the side menu on wide screens. */}
          {NAV.map((group) => (
            <Fragment key={group.label}>
              <p className="topbar__heading" aria-hidden="true">{group.label}</p>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} data-help={`nav:${item.to}`}>
                  <Icon name={item.icon} className="nav-icon" />
                  {item.label}
                </NavLink>
              ))}
            </Fragment>
          ))}
        </nav>
        <div className="topbar__user">
          <div className="topbar__me">
            <MyAvatar email={user.email} />
            <span className="topbar__me-name">{user.email ?? user.username}</span>
          </div>
          <NavLink to="/settings" className="btn btn--ghost topbar__settings" data-help="nav:/settings"><Icon name="gear" />Settings</NavLink>
          {/* To the Desktop app card in Settings; a plain Link so only Settings shows as active. */}
          {SHOW_DOWNLOAD && <Link to="/settings#desktop-app" className="btn btn--ghost topbar__settings" data-help="nav:/settings#desktop-app"><Icon name="download" />Download app</Link>}
          {SHOW_INSTALL && <Link to="/settings#desktop-app" className="btn btn--ghost topbar__settings" data-help="nav:/settings#desktop-app"><Icon name="download" />Install app</Link>}
          <button className="btn btn--ghost" title={user.email ? `Signed in as ${user.email}` : undefined} onClick={() => setConfirmSignOut(true)}><Icon name="logout" />Sign out</button>
        </div>
      </header>
      <ConsolePalette onSignOut={() => setConfirmSignOut(true)} />
      <HelpChat />
      {confirmSignOut && (
        <Modal title="Sign out?" onClose={() => setConfirmSignOut(false)}>
          <div className="stack">
            <p>Are you sure you want to sign out of Booqy Console? You'll need your password and authenticator code to sign in again.</p>
            <div className="row">
              <button className="btn btn--primary" autoFocus onClick={() => signOut()}>Sign out</button>
              <button className="btn btn--ghost" onClick={() => setConfirmSignOut(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
      <main className="main">
        <div className="page" key={location.pathname}>
        <Suspense fallback={<SkelPage label="Loading the page"><SkelKpis /><SkelCard /></SkelPage>}>
        <Routes>
          <Route path="/" element={<TenantsPage />} />
          <Route path="/tenants/new" element={<NewTenantPage />} />
          <Route path="/tenants/:tenantId" element={<TenantPage />} />
          <Route path="/operators" element={<OperatorsPage me={user.username} />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/finance" element={<FinancePage />} />
          <Route path="/website" element={<WebsitePage />} />
          <Route path="/settings" element={<SettingsPage email={user.email} />} />
          <Route path="/download" element={<DownloadRedirect />} />
          <Route path="/outbox" element={<MailPage tab="outbox" />} />
          {/* Unknown address (old bookmark, /index.html from the home-screen app, a link from admin): straight to Customers instead of a dead end. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <BusyBar />
      <Shell />
    </BrowserRouter>
  </StrictMode>,
);
