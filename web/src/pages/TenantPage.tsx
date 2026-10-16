import { FormEvent, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import {
  Card, ErrorNotice, Field, Modal, Notice, Status, compact, fmtDate, useAction, useLoad,
} from "../components/ui";
import type { Location, LocationInput, Tenant, TenantDetail } from "../types";
import TerminalModal from "../components/TerminalModal";

const TABS = ["Overview", "Locations", "Users", "Plan", "Payments", "Domains", "Activity", "Danger zone"] as const;
type Tab = (typeof TABS)[number];

export default function TenantPage() {
  const { tenantId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const [tab, setTab] = useState<Tab>(search.get("stripe") ? "Payments" : "Overview");
  const { data, error, loading, reload } = useLoad(() => api.tenant(tenantId), [tenantId]);

  // Poll while something is in progress (onboarding, domain workflows, offboarding).
  const busy =
    data &&
    (["provisioning", "offboarding"].includes(data.tenant.status) ||
      data.domains.some((d) => ["pending_dns", "pending_validation", "removing"].includes(d.status)));
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(id);
  }, [busy, reload]);

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (!data) return <ErrorNotice error={error ?? "Not found"} />;
  const t = data.tenant;

  return (
    <>
      <p className="crumbs"><Link to="/">Customers</Link> / {t.name}</p>
      <div className="page-head">
        <div>
          <h1>{t.name} <Status value={t.status} /></h1>
          <p className="muted mono small">{t.slug} · {t.tenantId}</p>
        </div>
        <button className="btn btn--ghost" onClick={() => reload()}>Refresh</button>
      </div>

      {search.get("created") && t.status === "provisioning" && (
        <Notice kind="info">
          Customer created. Setting up: inviting {t.ownerEmail}, creating the Stripe account
          {t.slug ? " and the website" : ""}… this page updates by itself.
          <button className="link" onClick={() => setSearch({})}>Dismiss</button>
        </Notice>
      )}
      {t.status === "provisioning_failed" && <RetryBanner tenant={t} onDone={reload} />}
      <ErrorNotice error={error} />

      <nav className="tabs">
        {TABS.map((name) => (
          <button key={name} className={`tab${tab === name ? " tab--on" : ""}${name === "Danger zone" ? " tab--danger" : ""}`}
                  onClick={() => setTab(name)}>
            {name}
            {name === "Locations" && <span className="tab__n">{t.locationCount}/{t.entitlements.maxLocations}</span>}
          </button>
        ))}
      </nav>

      {tab === "Overview" && <Overview detail={data} onSaved={reload} />}
      {tab === "Locations" && <Locations detail={data} onChanged={reload} goPlan={() => setTab("Plan")} />}
      {tab === "Users" && <Users tenant={t} />}
      {tab === "Plan" && <PlanTab tenant={t} onSaved={reload} />}
      {tab === "Payments" && <Payments tenant={t} onChanged={reload} stripeParam={search.get("stripe")} />}
      {tab === "Domains" && <Domains detail={data} onChanged={reload} />}
      {tab === "Activity" && <Activity detail={data} />}
      {tab === "Danger zone" && <Danger tenant={t} onChanged={reload} />}
    </>
  );
}

function RetryBanner({ tenant, onDone }: { tenant: Tenant; onDone: () => void }) {
  const a = useAction();
  return (
    <Notice kind="error">
      <strong>Setup failed.</strong> {tenant.lastError}
      <div className="row">
        <button className="btn btn--small" disabled={a.busy}
                onClick={async () => { if (await a.run(() => api.retryOnboarding(tenant.tenantId))) onDone(); }}>
          {a.busy ? "Retrying…" : "Retry setup"}
        </button>
      </div>
      <ErrorNotice error={a.error} />
    </Notice>
  );
}

// ------------------------------------------------------------------ overview
const PROFILE_FIELDS: [keyof Tenant, string, string?][] = [
  ["name", "Restaurant / brand name"], ["legalName", "Legal name"], ["orgNumber", "Org. number"],
  ["vatNumber", "VAT number"], ["contactEmail", "Contact email"], ["contactPhone", "Contact phone"],
  ["billingEmail", "Billing email"], ["senderName", "Sender name", "Max 11 chars"], ["replyToEmail", "Reply-to email"],
];

function Overview({ detail, onSaved }: { detail: TenantDetail; onSaved: () => void }) {
  const t = detail.tenant;
  const [editing, setEditing] = useState(false);
  const initial = () => ({
    ...Object.fromEntries(PROFILE_FIELDS.map(([k]) => [k, (t[k] as string) ?? ""])),
    street: t.address?.street ?? "", postalCode: t.address?.postalCode ?? "", city: t.address?.city ?? "",
    notes: t.notes ?? "",
  }) as Record<string, string>;
  const [f, setF] = useState(initial);
  const a = useAction();

  async function save(e: FormEvent) {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    for (const [k] of PROFILE_FIELDS) if ((f[k] ?? "") !== ((t[k] as string) ?? "")) patch[k] = f[k] || null;
    if (f.notes !== (t.notes ?? "")) patch.notes = f.notes || null;
    const addr = { street: f.street, postalCode: f.postalCode, city: f.city };
    if (JSON.stringify(addr) !== JSON.stringify({ street: t.address?.street ?? "", postalCode: t.address?.postalCode ?? "", city: t.address?.city ?? "" }))
      patch.address = f.street || f.postalCode || f.city ? addr : null;
    if (Object.keys(patch).length === 0) return setEditing(false);
    if (await a.run(() => api.updateTenant(t.tenantId, patch))) { setEditing(false); onSaved(); }
  }

  return (
    <div className="cols">
      <Card title="Company" actions={!editing && <button className="btn btn--ghost" onClick={() => { setF(initial()); setEditing(true); }}>Edit</button>}>
        {!editing ? (
          <dl className="dl">
            {PROFILE_FIELDS.map(([k, label]) => <Row key={k} label={label} value={t[k] as string} />)}
            <Row label="Address" value={t.address && `${t.address.street}, ${t.address.postalCode} ${t.address.city}`} />
            <Row label="Notes" value={t.notes} />
          </dl>
        ) : (
          <form onSubmit={save} noValidate>
            <ErrorNotice error={a.error} />
            <div className="grid">
              {PROFILE_FIELDS.map(([k, label, hint]) => (
                <Field key={k} label={label} hint={hint} error={a.fields[k]} required={k === "name"}>
                  <input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
                </Field>
              ))}
              <Field label="Street" error={a.fields["address.street"]}><input className="input" value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} /></Field>
              <Field label="Postal code" error={a.fields["address.postalCode"]}><input className="input" value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} /></Field>
              <Field label="City" error={a.fields["address.city"]}><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
              <Field label="Internal notes" wide error={a.fields.notes}><textarea className="input" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
            </div>
            <div className="row">
              <button className="btn btn--primary" disabled={a.busy}>{a.busy ? "Saving…" : "Save"}</button>
              <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        )}
      </Card>
      <div className="stack">
        <Card title="At a glance">
          <dl className="dl">
            <Row label="Owner" value={t.ownerName && `${t.ownerName} · ${t.ownerEmail}`} />
            <Row label="Plan" value={`${t.planId} — ${t.locationCount} of ${t.entitlements.maxLocations} locations`} />
            <Row label="Features" value={Object.entries(t.entitlements.features).filter(([, on]) => on).map(([k]) => k).join(", ")} />
            <Row label="Payments" value={t.stripe?.chargesEnabled ? "Ready" : t.stripe?.accountId ? "Stripe setup not finished" : "No Stripe account yet"} />
            <Row label="Website" value={t.primaryDomain} />
            <Row label="Users" value={String(detail.userCount)} />
            <Row label="Setup run" value={detail.onboarding ? `${detail.onboarding.status} · ${fmtDate(detail.onboarding.startDate)}` : undefined} />
            <Row label="Created" value={`${fmtDate(t.createdAt)}`} />
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (<><dt>{label}</dt><dd>{value || <span className="muted">—</span>}</dd></>);
}

// ----------------------------------------------------------------- locations
function Locations({ detail, onChanged, goPlan }: { detail: TenantDetail; onChanged: () => void; goPlan: () => void }) {
  const t = detail.tenant;
  const [edit, setEdit] = useState<Location | "new" | null>(null);
  const [del, setDel] = useState<Location | null>(null);
  const [term, setTerm] = useState<Location | null>(null);
  const atLimit = t.locationCount >= t.entitlements.maxLocations;
  return (
    <Card title={`Locations — ${t.locationCount} of ${t.entitlements.maxLocations}`}
          actions={<button className="btn btn--primary" onClick={() => setEdit("new")}>+ Add location</button>}>
      {atLimit && (
        <Notice kind="warn">
          The plan's limit is reached. Adding a location will offer to raise the limit by one — or change the plan in <button className="link" onClick={goPlan}>Plan</button>.
        </Notice>
      )}
      <table className="table">
        <thead><tr><th>Name</th><th>Address</th><th>Contact</th><th>Stripe override</th><th>Card terminals</th><th /></tr></thead>
        <tbody>
          {detail.locations.map((l) => (
            <tr key={l.locationId}>
              <td className="strong">{l.name}<div className="muted small mono">{l.locationId}</div></td>
              <td>{l.address}</td>
              <td className="small">{[l.phone, l.email].filter(Boolean).join(" · ") || <span className="muted">—</span>}</td>
              <td className="small mono">{l.stripeAccountId ?? <span className="muted">tenant's</span>}</td>
              <td className="small">
                {l.terminal ? <span className="status status--active">Enabled</span> : <span className="muted">Off</span>}
                <button className="btn btn--ghost btn--small" style={{ marginLeft: 6 }} onClick={() => setTerm(l)}>Manage</button>
              </td>
              <td className="right">
                <button className="btn btn--ghost btn--small" onClick={() => setEdit(l)}>Edit</button>
                <button className="btn btn--ghost btn--small danger" onClick={() => setDel(l)}>Delete</button>
              </td>
            </tr>
          ))}
          {detail.locations.length === 0 && <tr><td colSpan={6} className="empty">No locations yet.</td></tr>}
        </tbody>
      </table>
      {edit && <LocationModal tenant={t} location={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
      {del && <DeleteLocationModal tenant={t} location={del} onClose={() => setDel(null)} onDone={() => { setDel(null); onChanged(); }} />}
      {term && <TerminalModal tenant={t} location={term} goPlan={goPlan} onClose={() => { setTerm(null); onChanged(); }} />}
    </Card>
  );
}

function LocationModal({ tenant, location, onClose, onSaved }: { tenant: Tenant; location: Location | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<LocationInput>({
    name: location?.name ?? "", address: location?.address ?? "", phone: location?.phone ?? "",
    email: location?.email ?? "", stripeAccountId: location?.stripeAccountId ?? "",
  });
  const a = useAction();
  const [needsRaise, setNeedsRaise] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (location) {
      const patch: Record<string, string> = {};
      (Object.keys(f) as (keyof LocationInput)[]).forEach((k) => {
        if ((f[k] ?? "") !== ((location[k] as string) ?? "")) patch[k] = f[k] ?? "";
      });
      if (!Object.keys(patch).length) return onClose();
      if (await a.run(() => api.updateLocation(tenant.tenantId, location.locationId, patch))) onSaved();
      return;
    }
    const res = await a.run(() => api.createLocation(tenant.tenantId, compact(f) as LocationInput));
    if (res) onSaved();
  }

  async function raiseAndAdd() {
    const res = await a.run(async () => {
      await api.setPlan(tenant.tenantId, {
        planId: tenant.planId,
        overrides: { maxLocations: tenant.entitlements.maxLocations + 1, features: tenant.entitlements.features },
      });
      return api.createLocation(tenant.tenantId, compact(f) as LocationInput);
    });
    if (res) onSaved();
  }

  useEffect(() => {
    if (a.error instanceof ApiError && a.error.code === "plan_limit_reached") setNeedsRaise(true);
  }, [a.error]);

  return (
    <Modal title={location ? `Edit ${location.name}` : "Add location"} onClose={onClose}>
      <form onSubmit={save} noValidate>
        {needsRaise ? (
          <Notice kind="warn">
            {tenant.name} is on {tenant.entitlements.maxLocations} location(s). Raise the limit to {tenant.entitlements.maxLocations + 1} and add this one?
            <div className="row">
              <button type="button" className="btn btn--primary btn--small" disabled={a.busy} onClick={raiseAndAdd}>Raise limit and add</button>
            </div>
          </Notice>
        ) : <ErrorNotice error={a.error} />}
        <div className="grid">
          <Field label="Name" required error={a.fields.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
          <Field label="Address" required error={a.fields.address}><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label="Phone" error={a.fields.phone}><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Email" error={a.fields.email}><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Separate Stripe account" wide error={a.fields.stripeAccountId}
                 hint="Only if this location is a different company (own org. number). Empty = the customer's account.">
            <input className="input mono" value={f.stripeAccountId} onChange={(e) => setF({ ...f, stripeAccountId: e.target.value })} placeholder="acct_…" />
          </Field>
        </div>
        <div className="row">
          <button className="btn btn--primary" disabled={a.busy}>{a.busy ? "Saving…" : "Save"}</button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteLocationModal({ tenant, location, onClose, onDone }: { tenant: Tenant; location: Location; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const a = useAction();
  return (
    <Modal title={`Delete ${location.name}?`} onClose={onClose}>
      <p>The location disappears from the admin app and the website, and frees a slot in the plan. Its menu, reservations and orders stay stored but are no longer reachable. This can't be undone.</p>
      <Field label={`Type "${location.name}" to confirm`}><input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>
      <ErrorNotice error={a.error} />
      <div className="row">
        <button className="btn btn--danger" disabled={typed !== location.name || a.busy}
                onClick={async () => { if (await a.run(() => api.deleteLocation(tenant.tenantId, location.locationId))) onDone(); }}>
          Delete location
        </button>
        <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------- users
function Users({ tenant }: { tenant: Tenant }) {
  const users = useLoad(() => api.users(tenant.tenantId), [tenant.tenantId]);
  const [f, setF] = useState({ email: "", name: "" });
  const a = useAction();
  return (
    <div className="cols">
      <Card title="Sign-in accounts">
        <ErrorNotice error={users.error} />
        <table className="table">
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Since</th></tr></thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.cognitoSub}>
                <td>{u.name}<div className="muted small">{u.email}</div></td>
                <td>{u.role === "owner_user" ? "Owner" : "Staff"}</td>
                <td>{u.status ?? "active"}</td>
                <td className="small">{fmtDate(u.createdAt)}</td>
              </tr>
            ))}
            {users.data?.length === 0 && <tr><td colSpan={4} className="empty">No users yet — the owner invite is sent during setup.</td></tr>}
          </tbody>
        </table>
        <p className="muted small">Owners invite their own staff from the restaurant admin app.</p>
      </Card>
      <Card title="Invite another owner">
        <form noValidate onSubmit={async (e) => {
          e.preventDefault();
          if (await a.run(() => api.inviteOwner(tenant.tenantId, f.email, f.name))) { setF({ email: "", name: "" }); void users.reload(); }
        }}>
          <ErrorNotice error={a.error} />
          <Field label="Name" required error={a.fields.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Business email" required error={a.fields.email} hint="Gets a temporary password by email">
            <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <button className="btn btn--primary" disabled={a.busy || !f.email || !f.name}>{a.busy ? "Inviting…" : "Send invite"}</button>
        </form>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------- plan
function PlanTab({ tenant, onSaved }: { tenant: Tenant; onSaved: () => void }) {
  const plans = useLoad(() => api.plans());
  const [planId, setPlanId] = useState(tenant.planId);
  const [maxLocations, setMax] = useState(String(tenant.entitlements.maxLocations));
  const [features, setFeatures] = useState(tenant.entitlements.features);
  const a = useAction();
  const plan = plans.data?.find((p) => p.planId === planId);

  useEffect(() => {
    // Back on the current plan: show the tenant's real limits (incl. overrides);
    // another plan: start from that plan's defaults.
    if (planId === tenant.planId) {
      setMax(String(tenant.entitlements.maxLocations));
      setFeatures(tenant.entitlements.features);
    } else if (plan) {
      setMax(String(plan.maxLocations));
      setFeatures(plan.features);
    }
  }, [planId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(force = false) {
    const overrides: Record<string, unknown> = {};
    if (plan && Number(maxLocations) !== plan.maxLocations) overrides.maxLocations = Number(maxLocations);
    const changed = plan ? Object.fromEntries(Object.entries(features).filter(([k, v]) => plan.features[k] !== v)) : {};
    if (Object.keys(changed).length) overrides.features = changed;
    if (await a.run(() => api.setPlan(tenant.tenantId, { planId, overrides, force }))) onSaved();
  }
  const belowCount = a.error instanceof ApiError && a.error.code === "below_location_count";

  return (
    <Card title="Plan & limits">
      <p className="muted small">Takes effect immediately — e.g. a customer opening a second restaurant: raise "Locations allowed", then add the location.</p>
      <div className="plans">
        {(plans.data ?? []).map((p) => (
          <label key={p.planId} className={`plan${planId === p.planId ? " plan--on" : ""}`}>
            <input type="radio" checked={planId === p.planId} onChange={() => setPlanId(p.planId)} />
            <strong>{p.name}</strong><span>{p.maxLocations} location(s)</span>
          </label>
        ))}
      </div>
      <div className="grid">
        <Field label="Locations allowed" error={a.fields["overrides.maxLocations"]} hint={`In use: ${tenant.locationCount}`}>
          <input className="input" type="number" min={1} max={100} value={maxLocations} onChange={(e) => setMax(e.target.value)} />
        </Field>
        <div className="field">
          <span className="field__label">Features</span>
          <div className="checks">
            {Object.keys({ ...(plan?.features ?? {}), ...features }).map((k) => (
              <label key={k} className="check">
                <input type="checkbox" checked={!!features[k]} onChange={(e) => setFeatures({ ...features, [k]: e.target.checked })} /> {k}
              </label>
            ))}
          </div>
        </div>
      </div>
      {belowCount ? (
        <Notice kind="warn">
          {(a.error as ApiError).message}
          <div className="row"><button className="btn btn--small btn--danger" onClick={() => save(true)}>Apply anyway</button></div>
        </Notice>
      ) : <ErrorNotice error={a.error} />}
      <button className="btn btn--primary" disabled={a.busy || !plan} onClick={() => save()}>{a.busy ? "Saving…" : "Save plan"}</button>
    </Card>
  );
}

// ------------------------------------------------------------------ payments
function Payments({ tenant, onChanged, stripeParam }: { tenant: Tenant; onChanged: () => void; stripeParam: string | null }) {
  const s = tenant.stripe ?? {};
  const link = useAction();
  const sync = useAction();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (stripeParam === "return" && s.accountId) void sync.run(() => api.stripeSync(tenant.tenantId)).then(() => onChanged());
  }, [stripeParam]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card title="Stripe (Connect)">
      <p className="muted small">
        The restaurant gets its own Stripe account connected to your platform account — they're the merchant, money goes to them, and
        they see everything in their own Stripe dashboard. No keys are exchanged. What's left after setup is Stripe's identity
        and bank details form, which the owner fills in from their admin app (Settings → Payments) or via a link from here.
      </p>
      {stripeParam === "refresh" && <Notice kind="warn">That onboarding link expired — create a new one.</Notice>}
      <dl className="dl">
        <Row label="Connected account" value={s.accountId} />
        <Row label="Details submitted" value={s.accountId ? (s.detailsSubmitted ? "Yes" : "No") : undefined} />
        <Row label="Can take payments" value={s.accountId ? (s.chargesEnabled ? "Yes" : "Not yet") : undefined} />
        <Row label="Payouts" value={s.accountId ? (s.payoutsEnabled ? "Enabled" : "Paused") : undefined} />
        <Row label="Stripe still needs" value={s.requirementsDue?.length ? s.requirementsDue.join(", ") : undefined} />
        <Row label="Last updated" value={s.updatedAt ? fmtDate(s.updatedAt) : undefined} />
      </dl>
      {s.disconnected && <Notice kind="error">The restaurant disconnected your platform in Stripe. Payments are off until they reconnect.</Notice>}
      {!s.accountId && <Notice kind="info">The connected account is created by the setup run{tenant.status === "provisioning" ? " — in progress" : ""}.</Notice>}
      <ErrorNotice error={link.error ?? sync.error} />
      {url && (
        <Notice kind="ok">
          Onboarding link (expires within minutes — open it now, or share on a call):
          <div className="copy"><input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} />
            <button className="btn btn--small" onClick={() => navigator.clipboard.writeText(url)}>Copy</button>
            <a className="btn btn--small" href={url} target="_blank" rel="noreferrer">Open</a></div>
        </Notice>
      )}
      <div className="row">
        <button className="btn btn--primary" disabled={!s.accountId || link.busy}
                onClick={async () => { const r = await link.run(() => api.stripeLink(tenant.tenantId)); if (r) setUrl(r.url); }}>
          Create onboarding link
        </button>
        <button className="btn btn--ghost" disabled={!s.accountId || sync.busy}
                onClick={async () => { if (await sync.run(() => api.stripeSync(tenant.tenantId))) onChanged(); }}>
          {sync.busy ? "Checking…" : "Check status with Stripe"}
        </button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------- domains
function Domains({ detail, onChanged }: { detail: TenantDetail; onChanged: () => void }) {
  const t = detail.tenant;
  const [domain, setDomain] = useState("");
  const [makePrimary, setPrimary] = useState(true);
  const [dns, setDns] = useState<{ name: string; value: string } | null>(null);
  const add = useAction();
  const remove = useAction();
  return (
    <div className="cols">
      <Card title="Website domains">
        <table className="table">
          <thead><tr><th>Domain</th><th>Type</th><th>Status</th><th /></tr></thead>
          <tbody>
            {detail.domains.map((d) => (
              <tr key={d.domain}>
                <td className="strong">{d.domain} {d.primary && <span className="tag">primary</span>}
                  {d.lastError && <div className="small error-text">{d.lastError}</div>}</td>
                <td>{d.kind === "platform" ? "Platform" : "Customer's own"}</td>
                <td><Status value={d.status} /></td>
                <td className="right">{d.kind === "custom" && d.status !== "removing" && (
                  <button className="btn btn--ghost btn--small danger" disabled={remove.busy}
                          onClick={async () => {
                            if (window.confirm(`Remove ${d.domain}? The site stops answering on it.`) &&
                                await remove.run(() => api.removeDomain(t.tenantId, d.domain))) onChanged();
                          }}>Remove</button>
                )}</td>
              </tr>
            ))}
            {detail.domains.length === 0 && <tr><td colSpan={4} className="empty">No domains yet (the platform subdomain appears once a platform domain is configured).</td></tr>}
          </tbody>
        </table>
        <ErrorNotice error={remove.error} />
      </Card>
      <Card title="Add the customer's own domain">
        <form noValidate onSubmit={async (e) => {
          e.preventDefault();
          const r = await add.run(() => api.addDomain(t.tenantId, domain, makePrimary));
          if (r) { setDns(r.dns[0]); setDomain(""); onChanged(); }
        }}>
          <ErrorNotice error={add.error} />
          <Field label="Domain" error={add.fields.domain} hint="e.g. www.restaurang.se — the apex (restaurang.se) usually can't be a CNAME">
            <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.restaurang.se" />
          </Field>
          <label className="check"><input type="checkbox" checked={makePrimary} onChange={(e) => setPrimary(e.target.checked)} /> Use for links in emails (primary)</label>
          <button className="btn btn--primary" disabled={!domain || add.busy}>Add domain</button>
        </form>
        {dns && (
          <Notice kind="ok">
            Send the restaurant this DNS record to add at their DNS host:
            <pre className="code">{`${dns.name}  CNAME  ${dns.value}`}</pre>
            The certificate is issued automatically once it's in place (status updates here).
          </Notice>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ activity
function Activity({ detail }: { detail: TenantDetail }) {
  return (
    <Card title="Activity (latest 25)">
      <ul className="timeline">
        {detail.audit.map((e, i) => (
          <li key={i}>
            <span className="small muted">{fmtDate(e.at)}</span>
            <strong>{e.action.replace(/_/g, " ")}</strong>
            <span className="small muted mono">{e.by}</span>
            {e.details && Object.keys(e.details).length > 0 && <code className="small">{JSON.stringify(e.details)}</code>}
          </li>
        ))}
        {detail.audit.length === 0 && <li className="muted">Nothing yet.</li>}
      </ul>
    </Card>
  );
}

// --------------------------------------------------------------- danger zone
function Danger({ tenant, onChanged }: { tenant: Tenant; onChanged: () => void }) {
  const a = useAction();
  const [failed, setFailed] = useState<string[]>([]);
  const lifecycle = async (fn: () => Promise<unknown>) => {
    const r = (await a.run(fn)) as { failed?: string[] } | undefined;
    if (r) { setFailed(r.failed ?? []); onChanged(); }
  };
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const done = tenant.status === "offboarding" || tenant.status === "offboarded";
  return (
    <div className="stack">
      <Card title={tenant.status === "suspended" ? "Resume" : "Suspend"} tone="danger">
        <ErrorNotice error={a.error} />
        {failed.length > 0 && (
          <Notice kind="warn">Some users could not be updated - press the button again to retry: {failed.join(", ")}</Notice>
        )}
        {tenant.status === "suspended" ? (
          <>
            <p>Signs-in work again for every user that was active before the suspension. The website and online payments come back.</p>
            <div className="row">
              <button className="btn btn--primary" disabled={a.busy} onClick={() => lifecycle(() => api.resume(tenant.tenantId))}>Resume customer</button>
              <button className="btn btn--ghost" disabled={a.busy} onClick={() => lifecycle(() => api.suspend(tenant.tenantId, reason))}>Re-apply suspension</button>
            </div>
          </>
        ) : (
          <>
            <p>For unpaid invoices or abuse: every user is signed out and blocked, the website shows "unavailable", nothing is deleted. Reversible.</p>
            <Field label="Reason (kept in the activity log)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <button className="btn btn--danger" disabled={a.busy || tenant.status !== "active"}
                    onClick={() => { if (window.confirm(`Suspend ${tenant.name}?`)) void lifecycle(() => api.suspend(tenant.tenantId, reason)); }}>
              Suspend customer
            </button>
          </>
        )}
      </Card>
      <Card title="Delete (offboard) customer" tone="danger">
        <p>
          Disables and signs out all users, takes the website and its domains offline, and marks the customer offboarded.
          Their data is kept (bookkeeping records must be kept 7 years; exports on request) — permanent deletion is a separate,
          manual step. Their Stripe account stays theirs.
        </p>
        <Field label={`Type the slug "${tenant.slug}" to confirm`} error={a.fields.confirmSlug}>
          <input className="input mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={done} />
        </Field>
        {tenant.status === "provisioning" && <Notice kind="info">Wait until setup has finished before offboarding.</Notice>}
        <button className="btn btn--danger" disabled={done || tenant.status === "provisioning" || confirm !== tenant.slug || a.busy}
                onClick={async () => { if (await a.run(() => api.offboard(tenant.tenantId, confirm))) { setConfirm(""); onChanged(); } }}>
          {done ? `Customer is ${tenant.status}` : "Offboard customer"}
        </button>
      </Card>
    </div>
  );
}
