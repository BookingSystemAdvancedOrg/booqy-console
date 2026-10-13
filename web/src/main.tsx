import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { currentOperator, onAuthChange, signOut, type Operator } from "./auth";
import LoginPage, { RESET_PATH } from "./pages/LoginPage";
import TenantsPage from "./pages/TenantsPage";
import NewTenantPage from "./pages/NewTenantPage";
import TenantPage from "./pages/TenantPage";
import OperatorsPage from "./pages/OperatorsPage";
import OutboxPage from "./pages/OutboxPage";
import "./styles.css";

const ENV = import.meta.env.VITE_ENVIRONMENT ?? "dev";

function Shell() {
  const location = useLocation();
  const [user, setUser] = useState<Operator | null | undefined>(undefined);
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
  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (!user) return <LoginPage onSignedIn={refresh} />;

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">SBS <span>Admin</span></Link>
        <span className={`env env--${ENV}`}>{ENV}</span>
        <nav className="topbar__nav">
          <NavLink to="/" end>Customers</NavLink>
          <NavLink to="/tenants/new">New customer</NavLink>
          <NavLink to="/operators">Operators</NavLink>
          {ENV !== "prod" && <NavLink to="/outbox">Mail outbox</NavLink>}
        </nav>
        <div className="topbar__user">
          <span>{user.email || "operator"}</span>
          <button className="btn btn--ghost" onClick={() => signOut()}>Sign out</button>
        </div>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<TenantsPage />} />
          <Route path="/tenants/new" element={<NewTenantPage />} />
          <Route path="/tenants/:tenantId" element={<TenantPage />} />
          <Route path="/operators" element={<OperatorsPage me={user.username} />} />
          {ENV !== "prod" && <Route path="/outbox" element={<OutboxPage />} />}
          <Route path="*" element={<p>Not found. <Link to="/">Back to customers</Link></p>} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </StrictMode>,
);
