import { FormEvent, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import {
  Card, ErrorNotice, Field, Modal, Notice, Status, compact, fmtDate, useAction, useLoad, Printing } from "../components/ui";
import type { Location, LocationInput, Tenant, TenantDetail } from "../types";
import TerminalModal from "../components/TerminalModal";
import { PhoneInput } from "../components/PhoneInput";
import { POSTAL_CODE_INPUT, formatPostalCode, postalCodeDigits } from "../postalCode";
import { formatOrgNumber, orgNumberProblem, vatFromOrgNumber, vatPreview } from "../orgNumber";
import DomainWizard, { NameServerBox, SupportCaseBox, TransferModal, money } from "../components/DomainWizard";
import BillingTab from "../components/BillingTab";
import WebsiteTab from "../components/WebsiteTab";
import { setupFailure } from "./NewTenantPage";
import { RefreshButton, SaveButton, confirmLeave, useDirty, useFlash } from "../components/save";

const PLATFORM_DOMAIN = import.meta.env.VITE_PLATFORM_DOMAIN;

const TABS = ["Overview", "Locations", "Users", "Plan", "Billing", "Payments", "Domains", "Website", "Activity", "Danger zone"] as const;
type Tab = (typeof TABS)[number];

export default function TenantPage() {
  const { tenantId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const [tab, setTab] = useState<Tab>(search.get("stripe") ? "Payments" : search.get("tab") === "billing" ? "Billing" : search.get("tab") === "website" ? "Website" : "Overview");
  const { data, error, loading, reload } = useLoad(() => api.tenant(tenantId), [tenantId]);
  // Switching tabs drops what a form holds, so a dirty form asks first.
  const goTab = (next: Tab) => { if (next === tab || confirmLeave()) setTab(next); };
  // "Fix it" on the failed-setup banner: open Overview's edit form on that field.
  const [fixField, setFixField] = useState<string | null>(null);

  // Poll while something is in progress (onboarding, domain workflows, offboarding).
  const busy =
    data &&
    (["provisioning", "offboarding"].includes(data.tenant.status) ||
      data.onboarding?.status === "RUNNING" ||
      data.domains.some((d) => ["pending_dns", "pending_validation", "removing"].includes(d.status)) ||
      data.zones.some((z) => ZONE_BUSY.includes(z.status)));
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(id);
  }, [busy, reload]);

  if (loading && !data) return <Printing />;
  if (!data) return <ErrorNotice error={error ?? "Not found"} />;
  const t = data.tenant;

  return (
    <>
      <p className="crumbs"><Link to="/" onClick={(e) => { if (!confirmLeave()) e.preventDefault(); }}>Customers</Link> / {t.name}</p>
      <div className="page-head">
        <div>
          <h1>{t.name} <Status value={t.status} /></h1>
          <p className="muted mono small">{t.slug} · {t.tenantId}</p>
        </div>
        <RefreshButton reload={reload} />
      </div>

      {search.get("created") && t.status === "provisioning" && (
        <Notice kind="info">
          Customer created. Setting up: inviting {t.ownerEmail}, creating the Stripe account
          {t.slug ? " and the website" : ""}… this page updates by itself.
          <button className="link" onClick={() => setSearch({})}>Dismiss</button>
        </Notice>
      )}
      {t.status === "offboarded" && restorable(t) && (
        <Notice kind="warn">
          Offboarded. Restorable until <strong>{fmtDate(t.purgeAt)}</strong>; after that the data and the website repo are deleted.
          <button className="link" onClick={() => goTab("Danger zone")}>Restore or delete</button>
        </Notice>
      )}
      {t.status === "provisioning_failed" && (
        <RetryBanner tenant={t} onDone={reload} onFix={(field) => { if (confirmLeave()) { setTab("Overview"); setFixField(field); } }} />
      )}
      <ErrorNotice error={error} />

      <nav className="tabs">
        {TABS.map((name) => (
          <button key={name} className={`tab${tab === name ? " tab--on" : ""}${name === "Danger zone" ? " tab--danger" : ""}`}
                  onClick={() => goTab(name)}>
            {name}
            {name === "Locations" && <span className="tab__n">{t.locationCount}/{t.entitlements.maxLocations}</span>}
          </button>
        ))}
      </nav>

      {tab === "Overview" && <Overview detail={data} onSaved={reload} fixField={fixField} onFixed={() => setFixField(null)} />}
      {tab === "Locations" && <Locations detail={data} onChanged={reload} goPlan={() => goTab("Plan")} />}
      {tab === "Users" && <Users tenant={t} />}
      {tab === "Plan" && <PlanTab tenant={t} onSaved={reload} />}
      {tab === "Billing" && <BillingTab tenant={t} cardParam={search.get("card")} onChanged={reload} />}
      {tab === "Payments" && <Payments tenant={t} onChanged={reload} stripeParam={search.get("stripe")} />}
      {tab === "Domains" && <Domains detail={data} onChanged={reload} />}
      {tab === "Website" && <WebsiteTab tenant={t} />}
      {tab === "Activity" && <Activity detail={data} />}
      {tab === "Danger zone" && <Danger tenant={t} onChanged={reload} />}
    </>
  );
}

function RetryBanner({ tenant, onDone, onFix }: { tenant: Tenant; onDone: () => void; onFix: (field: string) => void }) {
  const a = useAction();
  const failure = setupFailure(tenant.lastError);
  const field = Object.keys(failure.fields)[0];
  return (
    <Notice kind="error">
      <strong>Setup failed.</strong> {field ? failure.fields[field] : failure.message}
      <div className="row">
        {field && <button className="btn btn--small btn--primary" onClick={() => onFix(field)}>Fix {FIX_LABEL[field] ?? field}</button>}
        <SaveButton kind="plain" small type="button" label="Retry setup" busy={a.busy} busyLabel="Retrying…" done={a.done} doneLabel="Started"
                    onClick={async () => { if (await a.run(() => api.retryOnboarding(tenant.tenantId))) onDone(); }} />
      </div>
      <ErrorNotice error={a.error} />
    </Notice>
  );
}

const FIX_LABEL: Record<string, string> = { ownerEmail: "the owner email" };

// ------------------------------------------------------------------ overview
const PROFILE_FIELDS: [keyof Tenant, string, string?][] = [
  ["name", "Restaurant / brand name"], ["legalName", "Legal name"], ["orgNumber", "Org. number"],
  ["vatNumber", "VAT number"], ["contactEmail", "Contact email"], ["contactPhone", "Contact phone"],
  ["billingEmail", "Billing email"], ["senderName", "Sender name", "Max 11 chars"], ["replyToEmail", "Reply-to email"],
];

// Editable only while setup has failed: the owner hasn't been invited yet.
const OWNER_FIELDS: [keyof Tenant, string, string?][] = [
  ["ownerName", "Owner full name"], ["ownerEmail", "Owner business email", "Used to sign in"], ["ownerPhone", "Owner phone"],
];

function Overview({ detail, onSaved, fixField, onFixed }: {
  detail: TenantDetail; onSaved: () => void; fixField: string | null; onFixed: () => void;
}) {
  const t = detail.tenant;
  const [editing, setEditing] = useState(false);
  const fields = t.status === "provisioning_failed" ? [...PROFILE_FIELDS, ...OWNER_FIELDS] : PROFILE_FIELDS;
  const failure = t.status === "provisioning_failed" ? setupFailure(t.lastError).fields : {};
  const initial = () => ({
    ...Object.fromEntries(fields.map(([k]) => [k, (t[k] as string) ?? ""])),
    street: t.address?.street ?? "", postalCode: formatPostalCode(t.address?.postalCode ?? ""), city: t.address?.city ?? "",
    notes: t.notes ?? "",
  }) as Record<string, string>;
  const [f, setF] = useState(initial);
  const a = useAction();
  const dirty = useDirty(f, initial(), { guard: editing });
  const [saved, flashSaved] = useFlash();
  useEffect(() => {
    if (!fixField) return;
    setF(initial());
    setEditing(true);
    window.setTimeout(() => {
      const el = document.getElementById(`e-${fixField}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
    }, 50);
    onFixed();
  }, [fixField]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (orgNumberProblem(f.orgNumber)) return;
    // The VAT number always follows the org. number (SE + 10 digits + 01).
    const values: Record<string, string> = { ...f, vatNumber: f.orgNumber ? vatFromOrgNumber(f.orgNumber) : "" };
    const patch: Record<string, unknown> = {};
    for (const [k] of fields) if ((values[k] ?? "") !== ((t[k] as string) ?? "")) patch[k] = values[k] || null;
    if (f.notes !== (t.notes ?? "")) patch.notes = f.notes || null;
    const addr = { street: f.street, postalCode: postalCodeDigits(f.postalCode), city: f.city };
    // Compared as digits: a stored "123 45" and the form's "12345" are the same code.
    if (JSON.stringify(addr) !== JSON.stringify({ street: t.address?.street ?? "", postalCode: postalCodeDigits(t.address?.postalCode ?? ""), city: t.address?.city ?? "" }))
      patch.address = f.street || f.postalCode || f.city ? addr : null;
    const failed = t.status === "provisioning_failed";
    if (Object.keys(patch).length === 0 && !failed) return setEditing(false);
    // After a failed setup, saving the fix runs setup again straight away.
    const ok = await a.run(async () => {
      if (Object.keys(patch).length) await api.updateTenant(t.tenantId, patch);
      return failed ? api.retryOnboarding(t.tenantId) : true;
    });
    if (ok) { setEditing(false); flashSaved(); onSaved(); }
  }

  return (
    <div className="cols">
      <Card title="Company" saved={saved} actions={!editing && <button className="btn btn--ghost" onClick={() => { setF(initial()); setEditing(true); }}>Edit</button>}>
        {!editing ? (
          <dl className="dl">
            {fields.map(([k, label]) => <Row key={k} label={label} value={t[k] as string} />)}
            <Row label="Address" value={t.address && `${t.address.street}, ${formatPostalCode(t.address.postalCode)} ${t.address.city}`} />
            <Row label="Notes" value={t.notes} />
          </dl>
        ) : (
          <form onSubmit={save} noValidate>
            <ErrorNotice error={a.error} />
            <div className="grid">
              {fields.map(([k, label, hint]) => (
                <Field key={k} label={label} required={k === "name" || k === "ownerName" || k === "ownerEmail"} changed={k !== "vatNumber" && dirty.changed(k)}
                       hint={k === "orgNumber" ? "10 digits, the dash is added for you" : k === "vatNumber" ? "SE + org. number + 01, filled in from the org. number" : hint}
                       error={a.fields[k] ?? (f[k] === ((t[k] as string) ?? "") ? failure[k] : undefined) ?? (k === "orgNumber" ? orgNumberProblem(f.orgNumber) : undefined)}>
                  {k === "contactPhone" || k === "ownerPhone" ? (
                    <PhoneInput id={`e-${k}`} className="input" value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} />
                  ) : k === "orgNumber" ? (
                    <input className="input mono" inputMode="numeric" maxLength={11} placeholder="556677-8899" value={f[k]}
                           onChange={(e) => setF({ ...f, orgNumber: formatOrgNumber(e.target.value) })} />
                  ) : k === "vatNumber" ? (
                    <input className="input mono" value={vatPreview(f.orgNumber)} readOnly tabIndex={-1} placeholder="SE··········01" />
                  ) : (
                    <input id={`e-${k}`} className="input" type={k.endsWith("mail") || k === "ownerEmail" ? "email" : undefined} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
                  )}
                </Field>
              ))}
              <Field label="Street" changed={dirty.changed("street")} error={a.fields["address.street"]}><input className="input" value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} /></Field>
              <Field label="Postal code" changed={dirty.changed("postalCode")} error={a.fields["address.postalCode"]}><input className="input mono" {...POSTAL_CODE_INPUT} value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: formatPostalCode(e.target.value) })} /></Field>
              <Field label="City" changed={dirty.changed("city")} error={a.fields["address.city"]}><input className="input" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
              <Field label="Internal notes" wide changed={dirty.changed("notes")} error={a.fields.notes}><textarea className="input" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
            </div>
            <div className="row">
              <SaveButton label={t.status === "provisioning_failed" ? "Save and retry setup" : "Save"} busy={a.busy}
                          dirty={dirty.dirty} allowClean={t.status === "provisioning_failed"} />
              <button type="button" className="btn btn--ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        )}
      </Card>
      <div className="stack">
        <Card title="At a glance">
          <dl className="dl">
            <Row label="Owner" value={t.ownerName && `${t.ownerName} · ${t.ownerEmail}`} />
            <Row label="Plan" value={`${t.planId} - ${t.locationCount} of ${t.entitlements.maxLocations} locations`} />
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
  return (<><dt>{label}</dt><dd>{value || <span className="muted">-</span>}</dd></>);
}

// ----------------------------------------------------------------- locations
function Locations({ detail, onChanged, goPlan }: { detail: TenantDetail; onChanged: () => void; goPlan: () => void }) {
  const t = detail.tenant;
  const [edit, setEdit] = useState<Location | "new" | null>(null);
  const [del, setDel] = useState<Location | null>(null);
  const [term, setTerm] = useState<Location | null>(null);
  const [saved, flashSaved] = useFlash();
  const [savedLabel, setSavedLabel] = useState("Saved");
  const changed = (label: string) => { setSavedLabel(label); flashSaved(); onChanged(); };
  const atLimit = t.locationCount >= t.entitlements.maxLocations;
  return (
    <Card title={`Locations - ${t.locationCount} of ${t.entitlements.maxLocations}`} saved={saved} savedLabel={savedLabel}
          actions={<button className="btn btn--primary" onClick={() => setEdit("new")}>+ Add location</button>}>
      {atLimit && (
        <Notice kind="warn">
          The plan's limit is reached. Adding a location will offer to raise the limit by one - or change the plan in <button className="link" onClick={goPlan}>Plan</button>.
        </Notice>
      )}
      <table className="table">
        <thead><tr><th>Name</th><th>Address</th><th>Contact</th><th>Stripe override</th><th>Card terminals</th><th /></tr></thead>
        <tbody>
          {detail.locations.map((l) => (
            <tr key={l.locationId}>
              <td className="strong">{l.name}<div className="muted small mono">{l.locationId}</div></td>
              <td>{l.address}</td>
              <td className="small">{[l.phone, l.email].filter(Boolean).join(" · ") || <span className="muted">-</span>}</td>
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
      {edit && <LocationModal tenant={t} location={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); changed(edit === "new" ? "Added" : "Saved"); }} />}
      {del && <DeleteLocationModal tenant={t} location={del} onClose={() => setDel(null)} onDone={() => { setDel(null); changed("Deleted"); }} />}
      {term && <TerminalModal tenant={t} location={term} goPlan={goPlan} onClose={() => { setTerm(null); onChanged(); }} />}
    </Card>
  );
}

function LocationModal({ tenant, location, onClose, onSaved }: { tenant: Tenant; location: Location | null; onClose: () => void; onSaved: () => void }) {
  const initial: LocationInput = {
    name: location?.name ?? "", address: location?.address ?? "", phone: location?.phone ?? "",
    email: location?.email ?? "", stripeAccountId: location?.stripeAccountId ?? "",
  };
  const [f, setF] = useState<LocationInput>(initial);
  const a = useAction();
  const dirty = useDirty(f, initial);
  const close = () => { if (!dirty.dirty || window.confirm("Close without saving?")) onClose(); };
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
    <Modal title={location ? `Edit ${location.name}` : "Add location"} onClose={close}>
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
          <Field label="Name" required changed={!!location && dirty.changed("name")} error={a.fields.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
          <Field label="Address" required changed={!!location && dirty.changed("address")} error={a.fields.address}><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label="Phone" changed={!!location && dirty.changed("phone")} error={a.fields.phone}><PhoneInput className="input" value={f.phone ?? ""} onChange={(v) => setF({ ...f, phone: v })} /></Field>
          <Field label="Email" changed={!!location && dirty.changed("email")} error={a.fields.email}><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Separate Stripe account" wide changed={!!location && dirty.changed("stripeAccountId")} error={a.fields.stripeAccountId}
                 hint="Only if this location is a different company (own org. number). Empty = the customer's account.">
            <input className="input mono" value={f.stripeAccountId} onChange={(e) => setF({ ...f, stripeAccountId: e.target.value })} placeholder="acct_…" />
          </Field>
        </div>
        <div className="row">
          <SaveButton label={location ? "Save" : "Add location"} busy={a.busy} dirty={dirty.dirty} />
          <button type="button" className="btn btn--ghost" onClick={close}>Cancel</button>
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
        <SaveButton kind="danger" type="button" label="Delete location" busy={a.busy} busyLabel="Deleting…" disabled={typed !== location.name}
                    onClick={async () => { if (await a.run(() => api.deleteLocation(tenant.tenantId, location.locationId))) onDone(); }} />
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
  const dirty = useDirty(f, { email: "", name: "" });
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
            {users.data?.length === 0 && <tr><td colSpan={4} className="empty">No users yet - the owner invite is sent during setup.</td></tr>}
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
          <SaveButton label="Send invite" busy={a.busy} busyLabel="Inviting…" done={a.done} doneLabel="Invite sent"
                      dirty={dirty.dirty} disabled={!f.email || !f.name} />
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
  const ownPrice = tenant.billing?.priceSek;
  const [price, setPrice] = useState(ownPrice != null ? String(ownPrice) : "");
  const a = useAction();
  const plan = plans.data?.find((p) => p.planId === planId);
  const current = plans.data?.find((p) => p.planId === tenant.planId);
  // What is saved: the tenant's plan, limits (incl. overrides) and price (own, else the plan's).
  const savedPrice = ownPrice != null ? String(ownPrice) : current?.priceSek != null ? String(current.priceSek) : "";
  const dirty = useDirty(
    { planId, maxLocations, features, price },
    { planId: tenant.planId, maxLocations: String(tenant.entitlements.maxLocations), features: tenant.entitlements.features, price: savedPrice },
  );

  useEffect(() => {
    // Back on the current plan: show the tenant's real limits (incl. overrides)
    // and own price; another plan: start from that plan's defaults.
    if (planId === tenant.planId) {
      setMax(String(tenant.entitlements.maxLocations));
      setFeatures(tenant.entitlements.features);
      setPrice(ownPrice != null ? String(ownPrice) : plan?.priceSek != null ? String(plan.priceSek) : "");
    } else if (plan) {
      setMax(String(plan.maxLocations));
      setFeatures(plan.features);
      setPrice(plan.priceSek != null ? String(plan.priceSek) : "");
    }
  }, [planId, plan]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(force = false) {
    const overrides: Record<string, unknown> = {};
    if (plan && Number(maxLocations) !== plan.maxLocations) overrides.maxLocations = Number(maxLocations);
    const changed = plan ? Object.fromEntries(Object.entries(features).filter(([k, v]) => plan.features[k] !== v)) : {};
    if (Object.keys(changed).length) overrides.features = changed;
    const body: { planId: string; overrides: Record<string, unknown>; force: boolean; priceSek?: number } = { planId, overrides, force };
    if (price !== "") body.priceSek = Number(price);
    if (await a.run(() => api.setPlan(tenant.tenantId, body))) { dirty.markSaved(); onSaved(); }
  }
  const belowCount = a.error instanceof ApiError && a.error.code === "below_location_count";

  return (
    <Card title="Plan & limits">
      <p className="muted small">Limits take effect immediately - e.g. a customer opening a second restaurant: raise "Locations allowed", then add the location. A changed plan or price is invoiced from the next month; the paid month stays as it is.</p>
      <div className="plans">
        {(plans.data ?? []).map((p) => (
          <label key={p.planId} className={`plan${planId === p.planId ? " plan--on" : ""}${planId === p.planId && dirty.changed("planId") ? " plan--changed" : ""}`}>
            <input type="radio" checked={planId === p.planId} onChange={() => setPlanId(p.planId)} />
            <strong>{p.name}</strong><span>{p.maxLocations} location(s)</span>
          </label>
        ))}
      </div>
      <div className="grid">
        <Field label="Locations allowed" changed={dirty.changed("maxLocations")} error={a.fields["overrides.maxLocations"]} hint={`In use: ${tenant.locationCount}`}>
          <input className="input" type="number" min={1} max={100} value={maxLocations} onChange={(e) => setMax(e.target.value)} />
        </Field>
        <Field label="Monthly price, SEK ex VAT" changed={dirty.changed("price")} error={a.fields.priceSek}
               hint={plan?.priceSek != null ? `The plan's price is ${plan.priceSek} kr; a different amount is this customer's own price` : "Pick a plan"}>
          <input className="input mono" type="number" min={0} step={1} value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <div className={`field${dirty.changed("features") ? " field--changed" : ""}`}>
          <span className="field__label">Features</span>
          <div className="checks">
            {Object.keys({ ...(plan?.features ?? {}), ...features }).map((k) => (
              <label key={k} className={`check${!!features[k] !== !!tenant.entitlements.features[k] ? " check--changed" : ""}`}>
                <input type="checkbox" checked={!!features[k]} onChange={(e) => setFeatures({ ...features, [k]: e.target.checked })} /> {k}
              </label>
            ))}
          </div>
        </div>
      </div>
      {features.kassa && <Notice kind="warn">Kassa: turn it on for a paying restaurant only once fiskaly LIVE is on and the SKV 1509 declaration was sent at least 2 weeks ago.</Notice>}
      {belowCount ? (
        <Notice kind="warn">
          {(a.error as ApiError).message}
          <div className="row"><SaveButton kind="danger" small type="button" label="Apply anyway" busy={a.busy} onClick={() => void save(true)} /></div>
        </Notice>
      ) : <ErrorNotice error={a.error} />}
      <SaveButton type="button" label="Save plan" busy={a.busy} done={a.done} dirty={dirty.dirty} disabled={!plan} onClick={() => void save()} />
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
        The restaurant gets its own Stripe account connected to your platform account - they're the merchant, money goes to them, and
        they see everything in their own Stripe dashboard. No keys are exchanged. What's left after setup is Stripe's identity
        and bank details form, which the owner fills in from their admin app (Settings → Payments) or via a link from here.
      </p>
      {stripeParam === "refresh" && <Notice kind="warn">That onboarding link expired - create a new one.</Notice>}
      <dl className="dl">
        <Row label="Connected account" value={s.accountId} />
        <Row label="Details submitted" value={s.accountId ? (s.detailsSubmitted ? "Yes" : "No") : undefined} />
        <Row label="Can take payments" value={s.accountId ? (s.chargesEnabled ? "Yes" : "Not yet") : undefined} />
        <Row label="Payouts" value={s.accountId ? (s.payoutsEnabled ? "Enabled" : "Paused") : undefined} />
        <Row label="Stripe still needs" value={s.requirementsDue?.length ? s.requirementsDue.join(", ") : undefined} />
        <Row label="Last updated" value={s.updatedAt ? fmtDate(s.updatedAt) : undefined} />
      </dl>
      {s.disconnected && <Notice kind="error">The restaurant disconnected your platform in Stripe. Payments are off until they reconnect.</Notice>}
      {!s.accountId && <Notice kind="info">The connected account is created by the setup run{tenant.status === "provisioning" ? " - in progress" : ""}.</Notice>}
      <ErrorNotice error={link.error ?? sync.error} />
      {url && (
        <Notice kind="ok">
          Onboarding link (expires within minutes - open it now, or share on a call):
          <div className="copy"><input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} />
            <button className="btn btn--small" onClick={() => navigator.clipboard.writeText(url)}>Copy</button>
            <a className="btn btn--small" href={url} target="_blank" rel="noreferrer">Open</a></div>
        </Notice>
      )}
      <div className="row">
        <SaveButton type="button" label="Create onboarding link" busy={link.busy} busyLabel="Creating…" done={link.done} doneLabel="Link ready"
                    disabled={!s.accountId} onClick={async () => { const r = await link.run(() => api.stripeLink(tenant.tenantId)); if (r) setUrl(r.url); }} />
        <SaveButton kind="ghost" type="button" label="Check status with Stripe" busy={sync.busy} busyLabel="Checking…" done={sync.done} doneLabel="Status updated"
                    disabled={!s.accountId} onClick={async () => { if (await sync.run(() => api.stripeSync(tenant.tenantId))) onChanged(); }} />
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------- domains
const ZONE_BUSY = ["creating_zone", "registered", "attaching"];

function Domains({ detail, onChanged }: { detail: TenantDetail; onChanged: () => void }) {
  const t = detail.tenant;
  const [wizard, setWizard] = useState(false);
  const [transfer, setTransfer] = useState<string | null>(null);
  const remove = useAction();
  return (
    <div className="stack">
      <Card title="Domains we run DNS for" actions={<button className="btn btn--primary" onClick={() => setWizard(true)}>Add domain</button>}>
        <table className="table">
          <thead><tr><th>Domain</th><th>How</th><th>Status</th><th /></tr></thead>
          <tbody>
            {detail.zones.map((z) => (
              <tr key={z.domain}>
                <td className="strong mono">{z.domain}
                  {z.statusDetail && <div className="small muted">{z.statusDetail}</div>}
                  {z.lastError && <div className="small error-text">{z.lastError}</div>}</td>
                <td className="small">{z.mode === "register" ? <>Bought{z.price && <> · {money(z.price)}, renews {money(z.renewalPrice)}/yr</>}</>
                  : <>Connected{z.importedRecords !== undefined && <> · {z.importedRecords} records copied</>}</>}
                  <div className="muted">Registrar: {z.registrar === "route53" ? "Route 53 (ours)" : "their own"}</div>
                  {z.transfer && z.transfer.status !== "transferred" && (
                    <div>Transfer: <Status value={z.transfer.status} />
                      {z.transfer.statusDetail && <div className="muted">{z.transfer.statusDetail}</div>}
                      {z.transfer.error && <div className="error-text">{z.transfer.error}</div>}</div>
                  )}</td>
                <td><Status value={z.status} /></td>
                <td className="right small muted">{fmtDate(z.updatedAt ?? z.requestedAt)}
                  {z.transferable && <div><button className="btn btn--small" onClick={() => setTransfer(z.domain)}>Transfer to Route 53</button></div>}</td>
              </tr>
            ))}
            {detail.zones.length === 0 && <tr><td colSpan={4} className="empty">None yet - <button className="link" onClick={() => setWizard(true)}>add a domain</button>.</td></tr>}
          </tbody>
        </table>
        {detail.zones.filter((z) => z.supportCase ?? z.transfer?.supportCase).map((z) => (
          <SupportCaseBox key={z.domain} domain={z.domain} tenantId={t.tenantId} supportCase={(z.supportCase ?? z.transfer?.supportCase)!} />
        ))}
        {detail.zones.filter((z) => z.status === "awaiting_nameservers" && z.nameServers).map((z) => (
          <NameServerBox key={z.domain} domain={z.domain} nameServers={z.nameServers!} />
        ))}
        {detail.zones.some((z) => z.status === "live") && (
          <p className="small muted">Live domains: add them (and www.) to the Turnstile widget's hostnames in Cloudflare, or online booking won't work there.</p>
        )}
      </Card>
      <Card title="Website hostnames" saved={remove.done} savedLabel="Removing" actions={t.status === "active" && <RerunSetup tenant={t} running={detail.onboarding?.status === "RUNNING"} onDone={onChanged} />}>
        {t.status === "active" && !detail.domains.some((d) => d.kind === "platform") && (
          <Notice kind="info">
            No {PLATFORM_DOMAIN ? <span className="mono">{t.slug}.{PLATFORM_DOMAIN}</span> : "platform"} address yet - this
            customer was set up before platform addresses were switched on. <strong>Re-run setup</strong> adds it.
          </Notice>
        )}
        <table className="table">
          <thead><tr><th>Hostname</th><th>Type</th><th>Status</th><th /></tr></thead>
          <tbody>
            {detail.domains.map((d) => (
              <tr key={d.domain}>
                <td className="strong">{d.domain} {d.primary && <span className="tag">primary</span>}
                  {d.lastError && <div className="small error-text">{d.lastError}</div>}</td>
                <td>{d.kind === "platform" ? "Platform" : "Restaurant's own"}</td>
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
            {detail.domains.length === 0 && <tr><td colSpan={4} className="empty">No hostnames yet - they appear here once a domain is attached.</td></tr>}
          </tbody>
        </table>
        <ErrorNotice error={remove.error} />
      </Card>
      {wizard && <DomainWizard tenant={t} onClose={() => setWizard(false)} onChanged={onChanged} />}
      {transfer && <TransferModal tenant={t} domain={transfer} onClose={() => setTransfer(null)} onDone={onChanged} />}
    </div>
  );
}

/**
 * Runs the onboarding workflow again for an active customer. Every step is
 * idempotent: it adds what is missing (the <slug> platform address, a new VAT
 * rate) and skips the rest - no second invite, no second Stripe account, and a
 * failed run never takes the customer offline.
 */
function RerunSetup({ tenant, running, onDone }: { tenant: Tenant; running: boolean; onDone: () => void }) {
  const a = useAction();
  return (
    <span className="row-actions">
      <SaveButton
        kind="ghost" small type="button" busy={a.busy} busyLabel="Starting…" done={a.done} doneLabel="Started"
        label={running ? "Setup running…" : "Re-run setup"}
        disabled={running}
        title="Adds anything missing from setup (like the platform address). No new invite, no new Stripe account."
        onClick={async () => {
          const ok = window.confirm(
            `Re-run setup for ${tenant.name}?\n\nAdds anything that's missing, like the platform address. ` +
              "It doesn't send a new invite, doesn't create another Stripe account and won't take the site offline.",
          );
          if (ok && (await a.run(() => api.retryOnboarding(tenant.tenantId)))) onDone();
        }}
      />
      {a.error != null && <ErrorNotice error={a.error} />}
    </span>
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
/** Restore works until purgeAt (none yet: until the next deletion run sets it). */
function restorable(t: Tenant): boolean {
  return t.status === "offboarded" && !t.purgeStartedAt && (!t.purgeAt || new Date(t.purgeAt).getTime() > Date.now());
}

export function Danger({ tenant, onChanged }: { tenant: Tenant; onChanged: () => void }) {
  const a = useAction();
  const [failed, setFailed] = useState<string[]>([]);
  const lifecycle = async (fn: () => Promise<unknown>) => {
    const r = (await a.run(fn)) as { failed?: string[] } | undefined;
    if (r) { setFailed(r.failed ?? []); onChanged(); }
  };
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const done = ["offboarding", "offboarded", "purged"].includes(tenant.status);
  if (done) {
    return (
      <div className="stack">
        {tenant.status === "offboarding" && <Notice kind="info">Offboarding is running: this page updates by itself.</Notice>}
        {tenant.status === "offboarded" && <Restore tenant={tenant} onChanged={onChanged} />}
        {tenant.status !== "offboarding" && <DeleteCustomer tenant={tenant} onChanged={onChanged} />}
      </div>
    );
  }
  return (
    <div className="stack">
      <Card title={tenant.status === "suspended" ? "Resume" : "Suspend"} tone="danger" saved={a.done} savedLabel="Done">
        <ErrorNotice error={a.error} />
        {failed.length > 0 && (
          <Notice kind="warn">Some users could not be updated - press the button again to retry: {failed.join(", ")}</Notice>
        )}
        {tenant.status === "suspended" ? (
          <>
            <p>Signs-in work again for every user that was active before the suspension. The website and online payments come back.</p>
            <div className="row">
              <SaveButton type="button" label="Resume customer" busy={a.busy} busyLabel="Working…" onClick={() => void lifecycle(() => api.resume(tenant.tenantId))} />
              <SaveButton kind="ghost" type="button" label="Re-apply suspension" busy={a.busy} busyLabel="Working…" onClick={() => void lifecycle(() => api.suspend(tenant.tenantId, reason))} />
            </div>
          </>
        ) : (
          <>
            <p>
              For unpaid invoices or abuse: every user is signed out and blocked and the website shows "unavailable".
              Nothing is deleted and nothing is archived; Resume undoes it at any time.
            </p>
            <Field label="Reason (kept in the activity log)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <SaveButton kind="danger" type="button" label="Suspend customer" busy={a.busy} busyLabel="Suspending…" disabled={tenant.status !== "active"}
                        onClick={() => { if (window.confirm(`Suspend ${tenant.name}?`)) void lifecycle(() => api.suspend(tenant.tenantId, reason)); }} />
          </>
        )}
      </Card>
      <Card title="Offboard customer" tone="danger">
        <p>
          The customer stops using Booqy: all users are signed out and blocked, the website and its domains go offline,
          the website repo is archived and the subscription ends.
        </p>
        <p>
          <strong>Restore</strong> brings everything back until the retention period is over (90 days in production).
          After that, or at once with <strong>Delete customer</strong>, the data and the website repo are deleted for good.
          Catering documents are kept 7 years for bookkeeping, and their Stripe account stays theirs.
        </p>
        <Field label={`Type the slug "${tenant.slug}" to confirm`} error={a.fields.confirmSlug}>
          <input className="input mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {tenant.status === "provisioning" && <Notice kind="info">Wait until setup has finished before offboarding.</Notice>}
        <SaveButton kind="danger" type="button" label="Offboard customer" busy={a.busy} busyLabel="Offboarding…" disabled={tenant.status === "provisioning" || confirm !== tenant.slug}
                    onClick={async () => { if (await a.run(() => api.offboard(tenant.tenantId, confirm))) { setConfirm(""); onChanged(); } }} />
      </Card>
    </div>
  );
}

function Restore({ tenant, onChanged }: { tenant: Tenant; onChanged: () => void }) {
  const a = useAction();
  const [result, setResult] = useState<{ failed: string[]; onboardingError?: string } | null>(null);
  if (!restorable(tenant)) return null;
  return (
    <Card title="Restore customer" saved={a.done} savedLabel="Restoring">
      <ErrorNotice error={a.error} />
      {result && result.failed.length > 0 && (
        <Notice kind="warn">Some users could not be enabled: {result.failed.join(", ")}</Notice>
      )}
      {result?.onboardingError && <Notice kind="warn">Setup did not start: {result.onboardingError}. Use Retry on the Overview tab.</Notice>}
      <p>
        Restorable until <strong>{fmtDate(tenant.purgeAt)}</strong>{!tenant.purgeAt && " (the date is set at the next deletion run)"}.
        Users can sign in again, the website comes back on {tenant.slug}.{PLATFORM_DOMAIN || "booqy.se"} and its repo is unarchived.
      </p>
      <p className="muted small">Own domains are added again on the Domains tab; start the subscription again on the Billing tab.</p>
      <SaveButton type="button" label="Restore customer" busy={a.busy} busyLabel="Restoring…"
                  onClick={async () => {
                    if (!window.confirm(`Restore ${tenant.name}?`)) return;
                    const r = await a.run(() => api.restore(tenant.tenantId));
                    if (r) { setResult(r); onChanged(); }
                  }} />
    </Card>
  );
}

function DeleteCustomer({ tenant, onChanged }: { tenant: Tenant; onChanged: () => void }) {
  const a = useAction();
  const [confirm, setConfirm] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  if (tenant.status === "purged") {
    return (
      <Card title="Customer deleted" tone="danger">
        <p>
          Deleted {fmtDate(tenant.purgedAt)}. Only this company record is left (no personal data). The slug is free again:
          New customer with "{tenant.slug}" starts with a fresh website repo. Catering documents are kept 7 years for bookkeeping.
        </p>
      </Card>
    );
  }
  const due = !restorable(tenant);
  return (
    <Card title="Delete customer" tone="danger">
      <ErrorNotice error={a.error} />
      {repoError && <Notice kind="warn">The website repo was not deleted: {repoError}. The deletion run tries again; the activity log has the details.</Notice>}
      {due ? (
        <Notice kind="info">The data and the website repo are deleted at the next deletion run (nightly in production). Nothing to do.</Notice>
      ) : (
        <>
          <p>
            Deletes the website repo now, and bookings, orders, menus, layouts, catering requests, marketing contacts,
            users and images at the next deletion run (nightly in production) instead of on {tenant.purgeAt ? fmtDate(tenant.purgeAt) : "the deletion date"}.
            Restore is no longer possible. This can't be undone.
          </p>
          <Field label={`Type the slug "${tenant.slug}" to confirm`} error={a.fields.confirmSlug}>
            <input className="input mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <SaveButton kind="danger" type="button" label="Delete customer" busy={a.busy} busyLabel="Deleting…" disabled={confirm !== tenant.slug}
                      onClick={async () => {
                        const r = await a.run(() => api.purgeNow(tenant.tenantId, confirm));
                        if (r) { setConfirm(""); setRepoError(r.repoError ?? null); onChanged(); }
                      }} />
        </>
      )}
    </Card>
  );
}
