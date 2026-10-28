import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { currentOperator, onAuthChange, signOut, type Operator } from "./auth";
import LoginPage, { RESET_PATH } from "./pages/LoginPage";
import TenantsPage from "./pages/TenantsPage";
import NewTenantPage from "./pages/NewTenantPage";
import TenantPage from "./pages/TenantPage";
import OperatorsPage from "./pages/OperatorsPage";
import MailPage from "./pages/MailPage";
import FinancePage from "./pages/FinancePage";
import WebsitePage from "./pages/WebsitePage";
import ReadersPage from "./pages/ReadersPage";
import { Logo } from "./components/Logo";
import { Modal, Printing } from "./components/ui";
import { ThemeToggle } from "./components/ThemeToggle";
import { BusyBar } from "./components/BusyBar";
import { confirmLeave } from "./components/save";
import "./styles.css";

// Production is the default and is never labelled; only dev says so.
const IS_DEV = (import.meta.env.VITE_ENVIRONMENT ?? "dev") === "dev";

function Shell() {
  const location = useLocation();
  const [user, setUser] = useState<Operator | null | undefined>(undefined);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const refresh = useCallback(() => {
    currentOperator().then(setUser);
  }, []);
  useEffect(() => {
    refresh();
    return onAuthChange(refresh);           // sign-out, failed token refresh, 401 from the API
  }, [refresh]);

  // The emailed reset link works signed in or out (LoginPage signs out
  // once the new password is set).
  if (location.pathname === RESET_PATH) return <LoginPage onSignedIn={refresh} />;
  if (user === undefined) return <div className="boot"><Printing label="Signing in" /></div>;
  if (!user) return <LoginPage onSignedIn={refresh} />;

  return (
    <div className="app">
      {/* A dirty form asks before any top bar link takes the operator away. */}
      <header className="topbar" onClickCapture={(e) => { if ((e.target as HTMLElement).closest("a[href]") && !confirmLeave()) e.preventDefault(); }}>
        <Link to="/" className="brand" aria-label="Booqy Console - customers"><Logo className="brand__logo" /><span className="brand__app">Console</span></Link>
        {IS_DEV && <span className="env">dev</span>}
        <nav className="topbar__nav">
          <NavLink to="/" end>Customers</NavLink>
          <NavLink to="/tenants/new">New customer</NavLink>
          <NavLink to="/readers">Card readers</NavLink>
          <NavLink to="/operators">Operators</NavLink>
          <NavLink to="/mail">Mail</NavLink>
          <NavLink to="/finance">Finance</NavLink>
          <NavLink to="/website">Website</NavLink>
        </nav>
        <div className="topbar__user">
          <span>{user.email || "operator"}</span>
          <ThemeToggle />
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
        <Routes>
          <Route path="/" element={<TenantsPage />} />
          <Route path="/tenants/new" element={<NewTenantPage />} />
          <Route path="/tenants/:tenantId" element={<TenantPage />} />
          <Route path="/readers" element={<ReadersPage />} />
          <Route path="/operators" element={<OperatorsPage me={user.username} />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/finance" element={<FinancePage />} />
          <Route path="/website" element={<WebsitePage />} />
          <Route path="/outbox" element={<MailPage tab="outbox" />} />
          <Route path="*" element={<p>Not found. <Link to="/">Back to customers</Link></p>} />
        </Routes>
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
