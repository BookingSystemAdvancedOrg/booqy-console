import { BRANCHES, BRANCH_LABEL, LEAVES, branchVisible, leafPath, treeOf } from "./settingsTree";
import { Fragment, StrictMode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { currentOperator, onAuthChange, refreshOperator, retryUntilReachable, signOut, type Operator } from "./auth";
import { firstName } from "./avatar";
import "./connectionNotice.css";
import LoginPage, { RESET_PATH } from "./pages/LoginPage";
import { Logo } from "./components/Logo";
import { Modal } from "./components/ui";
import { installPress } from "./press";
import { BusyBar } from "./components/BusyBar";
import { confirmLeave, discardUnsaved, hasUnsaved, restoreUnsaved } from "./components/save";
import { installGlide } from "./glide";
import { installGlassFilter } from "./glassFilter";
import { installDesktopGlass } from "./desktopGlass";
import { syncBackdropImage } from "./backdropStore";
import { MyAvatar } from "./components/MyAvatar";
import { startUpdateNotice } from "./updateNotice";
import { BUILT_N } from "./whatsNew";
import { showDownloadNav } from "./desktopDownloads";
import { DownloadRedirect } from "./components/DownloadRedirect";
import { DesktopHint, useDesktopHint } from "./components/DesktopHint";
import { installPwa, showPhoneInstallNav } from "./pwa";
import "@booqy/brand/styles.css";
import "./styles.css";
import "./ds.css";
import "./phoneTables.css";
import "./phoneTargets.css";
// Last: every edge transparent (no-edges rule, see the file).
import "./noEdges.css";
import { CommandPalette, Icon, PaletteTrigger, type IconName, type PaletteItem } from "./components/ds";
import { SkelCard, SkelKpis, SkelPage, SkelShell } from "./components/Skeleton";
import { HelpChat } from "./features/help/HelpChat";
import { TabBar } from "./components/TabBar";
import { badgeText, useUnseenNotices } from "./notices";
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
  reports: () => import("./pages/ReportsPage"),
  notifications: () => import("./pages/NotificationsPage"),
  settings: () => import("./pages/SettingsPage"),
  profile: () => import("./pages/ProfilePage"),
};
const TenantsPage = lazy(pages.tenants);
const NewTenantPage = lazy(pages.newTenant);
const TenantPage = lazy(pages.tenant);
const OperatorsPage = lazy(pages.operators);
const MailPage = lazy(pages.mail);
const FinancePage = lazy(pages.finance);
const WebsitePage = lazy(pages.website);
const ReportsPage = lazy(pages.reports);
const NotificationsPage = lazy(pages.notifications);
const SettingsPage = lazy(pages.settings);
const ProfilePage = lazy(pages.profile);

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
      failed: "The page didn't reload. Try again.", updated: "Updated", whatsNew: "New", more: "+{n} more",
    },
    // Also lists what is new since this build (src/whatsNew.ts).
    whatsNew: { since: BUILT_N },
    hasUnsaved,
    discardUnsaved,
    restoreUnsaved,
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
    { to: "/reports", label: "Reports", icon: "flag" },
    { to: "/notifications", label: "Notifications", icon: "bell" },
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
  { to: "/profile", label: "My profile", icon: "badge" },
  { to: "/settings", label: "Settings", icon: "gear" },
  ...(SHOW_DOWNLOAD ? [{ to: "/settings#desktop-app", label: "Download app", icon: "download" as const }] : []),
  ...(SHOW_INSTALL ? [{ to: "/settings#desktop-app", label: "Install app", icon: "download" as const }] : []),
];
// "My profile" in the phones' Workspace sheet (the side menu links it too).
const PROFILE_PATH = "/profile";
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
      // Settings, branch by branch and leaf by leaf: found by typing, opened in place.
      ...BRANCHES.filter(branchVisible).flatMap((b): PaletteItem[] => [
        { id: `s-${b}`, group: "Settings", label: BRANCH_LABEL[b], hint: treeOf(b).label, icon: "gear", searchOnly: true,
          keywords: LEAVES.filter((l) => l.branch === b).map((l) => `${l.label} ${l.keywords ?? ""}`).join(" "), run: () => go(`/settings#${b}`) },
        ...LEAVES.filter((l) => l.branch === b && l.label !== BRANCH_LABEL[b]).map((l): PaletteItem => ({
          id: `s-${b}-${l.label}`, group: "Settings", label: l.label, hint: BRANCH_LABEL[b], icon: "gear", searchOnly: true, keywords: l.keywords,
          run: () => { if (confirmLeave()) navigate(`/settings#${b}`, { state: { leaf: l.label } }); },
        })),
      ]),
      // Settings that link to their own page (Profile picture, Email brand template).
      ...LEAVES.flatMap((l): PaletteItem[] => {
        if (!l.to) return [];
        const to = l.to;
        const [tree, place] = leafPath(l);
        return [{ id: `s-${to}`, group: "Settings", label: l.label, hint: place === l.label ? tree : place, icon: "gear", searchOnly: true, keywords: l.keywords, run: () => go(to) }];
      }),
      ...recent
        .filter((p) => p !== here)
        .map(navFor)
        .filter((n): n is NavItem => !!n && !seen.has(n.to) && !!seen.add(n.to))
        .slice(0, 4)
        .map((n): PaletteItem => ({ id: `r-${n.to}`, group: "Recent", label: n.label, icon: n.icon, run: () => go(n.to) })),
    ];
  }, [go, navigate, onSignOut]);
  return <CommandPalette items={items} />;
}

function Shell() {
  const location = useLocation();
  const [user, setUser] = useState<Operator | null | undefined>(undefined);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [appHint, closeAppHint] = useDesktopHint();
  // Unseen notifications: the badge on Notifications in the side menu.
  const unseen = useUnseenNotices(Boolean(user));
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
  // My profile saved: fresh tokens so the menu shows the new name or email at once.
  const saveProfile = useCallback(async () => {
    try {
      const u = await refreshOperator();
      if (u) setUser(u);
    } catch { /* the next refresh picks it up */ }
  }, []);
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
      {/* A dirty form asks before any top bar link takes the operator away.
          Phones show only the logo here; the links are in the bottom bar (TabBar). */}
      <header className="topbar" onClickCapture={(e) => { if ((e.target as HTMLElement).closest("a[href]") && !confirmLeave()) e.preventDefault(); }}>
        <Link to="/" className="brand" aria-label="Booqy Console - customers"><Logo className="brand__logo" /><span className="brand__app">Console</span></Link>
        {IS_DEV && <span className="env">dev</span>}
        <PaletteTrigger />
        <nav className="topbar__nav">
          {/* The headings only show in the side menu on wide screens. */}
          {NAV.map((group) => (
            <Fragment key={group.label}>
              <p className="topbar__heading" aria-hidden="true">{group.label}</p>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} data-help={`nav:${item.to}`}
                         aria-label={item.to === "/notifications" && unseen > 0 ? `${item.label}, ${unseen} new` : undefined}>
                  <Icon name={item.icon} className="nav-icon" />
                  {item.label}
                  {item.to === "/notifications" && unseen > 0 && <span className="nav-badge" aria-hidden="true">{badgeText(unseen)}</span>}
                </NavLink>
              ))}
            </Fragment>
          ))}
        </nav>
        <div className="topbar__user">
          {appHint && <DesktopHint where="side" onClose={closeAppHint} />}
          {/* You: picture and first name, opens My profile. */}
          <NavLink to="/profile" className="topbar__me" data-help="nav:/profile" aria-label={`My profile, ${user.name || user.email}`}
                   title={user.name ? `${user.name}, ${user.email}` : user.email}>
            <MyAvatar name={user.name} email={user.email} />
            <span className="topbar__me-name">{firstName(user.name, user.email)}</span>
          </NavLink>
          <NavLink to="/settings" className="btn btn--ghost topbar__settings" data-help="nav:/settings"><Icon name="gear" />Settings</NavLink>
          {/* To the Desktop app card in Settings; a plain Link so only Settings shows as active. */}
          {SHOW_DOWNLOAD && <Link to="/settings#desktop-app" className="btn btn--ghost topbar__settings" data-help="nav:/settings#desktop-app"><Icon name="download" />Download app</Link>}
          {SHOW_INSTALL && <Link to="/settings#desktop-app" className="btn btn--ghost topbar__settings" data-help="nav:/settings#desktop-app"><Icon name="download" />Install app</Link>}
          <button className="btn btn--ghost" title={user.email ? `Signed in as ${user.email}` : undefined} onClick={() => setConfirmSignOut(true)}><Icon name="logout" />Sign out</button>
        </div>
      </header>
      <TabBar
        name={user.name}
        email={user.email}
        username={user.username}
        profilePath={PROFILE_PATH}
        showInstall={SHOW_INSTALL}
        showDownload={SHOW_DOWNLOAD}
        onSignOut={() => setConfirmSignOut(true)}
      />
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
        {appHint && <DesktopHint where="flow" onClose={closeAppHint} />}
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
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/settings" element={<SettingsPage email={user.email} />} />
          <Route path="/profile" element={<ProfilePage me={user} onSaved={saveProfile} />} />
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
