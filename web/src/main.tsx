import { StrictMode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { currentOperator, onAuthChange, signOut, type Operator } from "./auth";
import LoginPage, { RESET_PATH } from "./pages/LoginPage";
import { Logo } from "./components/Logo";
import { Modal } from "./components/ui";
import { installPress } from "./press";
import { BusyBar } from "./components/BusyBar";
import { confirmLeave } from "./components/save";
import { installGlide } from "./glide";
import { installGlassFilter } from "./glassFilter";
import "@booqy/brand/styles.css";
import "./styles.css";
import { SkelCard, SkelKpis, SkelPage, SkelShell } from "./components/Skeleton";

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
  readers: () => import("./pages/ReadersPage"),
  settings: () => import("./pages/SettingsPage"),
};
const TenantsPage = lazy(pages.tenants);
const NewTenantPage = lazy(pages.newTenant);
const TenantPage = lazy(pages.tenant);
const OperatorsPage = lazy(pages.operators);
const MailPage = lazy(pages.mail);
const FinancePage = lazy(pages.finance);
const WebsitePage = lazy(pages.website);
const ReadersPage = lazy(pages.readers);
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

// Production is the default and is never labelled; only dev says so.
const IS_DEV = (import.meta.env.VITE_ENVIRONMENT ?? "dev") === "dev";

function Shell() {
  const location = useLocation();
  const [user, setUser] = useState<Operator | null | undefined>(undefined);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // Phones: the links sit behind a Menu button. The menu belongs to the page
  // it was opened on, so going to another page closes it.
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const menuOpen = menuAt === location.pathname;
  const refresh = useCallback(() => {
    currentOperator().then(setUser);
  }, []);
  useEffect(() => {
    refresh();
    return onAuthChange(refresh);           // sign-out, failed token refresh, 401 from the API
  }, [refresh]);

  useEffect(() => {
    if (user) preloadPages();
  }, [user]);

  // The emailed reset link works signed in or out (LoginPage signs out
  // once the new password is set).
  if (location.pathname === RESET_PATH) return <LoginPage onSignedIn={refresh} />;
  if (user === undefined) return <SkelShell label="Signing in" />;
  if (!user) return <LoginPage onSignedIn={refresh} />;

  return (
    <div className="app">
      {/* A dirty form asks before any top bar link takes the operator away. */}
      <header className={menuOpen ? "topbar is-open" : "topbar"} onClickCapture={(e) => { if ((e.target as HTMLElement).closest("a[href]") && !confirmLeave()) e.preventDefault(); }}>
        <Link to="/" className="brand" aria-label="Booqy Console - customers"><Logo className="brand__logo" /><span className="brand__app">Console</span></Link>
        {IS_DEV && <span className="env">dev</span>}
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
          <p className="topbar__heading" aria-hidden="true">Restaurants</p>
          <NavLink to="/" end>Customers</NavLink>
          <NavLink to="/tenants/new">New customer</NavLink>
          <NavLink to="/readers">Card readers</NavLink>
          <p className="topbar__heading" aria-hidden="true">Platform</p>
          <NavLink to="/operators">Operators</NavLink>
          <NavLink to="/mail">Mail</NavLink>
          <p className="topbar__heading" aria-hidden="true">Numbers</p>
          <NavLink to="/finance">Finance</NavLink>
          <NavLink to="/website">Website</NavLink>
        </nav>
        <div className="topbar__user">
          <NavLink to="/settings" className="btn btn--ghost topbar__settings">Settings</NavLink>
          <button className="btn btn--ghost" title={user.email ? `Signed in as ${user.email}` : undefined} onClick={() => setConfirmSignOut(true)}>Sign out</button>
        </div>
      </header>
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
          <Route path="/readers" element={<ReadersPage />} />
          <Route path="/operators" element={<OperatorsPage me={user.username} />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/finance" element={<FinancePage />} />
          <Route path="/website" element={<WebsitePage />} />
          <Route path="/settings" element={<SettingsPage email={user.email} />} />
          <Route path="/outbox" element={<MailPage tab="outbox" />} />
          <Route path="*" element={<p>Not found. <Link to="/">Back to customers</Link></p>} />
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
