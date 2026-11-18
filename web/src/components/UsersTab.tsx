import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Card, ErrorNotice, Field, Modal, Notice, useAction, useLoad } from "./ui";
import type { Location, StaffAccess, Tenant, TenantUser, UserRole } from "../types";
import { RowActions } from "./RowActions";
import { SaveBar, useDirty } from "./save";
import { SkelPage, SkelRows } from "./Skeleton";
import { Select } from "./Select";
import { PhoneInput } from "./PhoneInput";
import { InfoTip } from "./StepFlow";
import "./usersTab.css";

/**
 * Customers / <restaurant> / Users: every sign-in account of the customer,
 * owners and staff. The API does each change with the admin app's own rules
 * (manage-user, Behörigheter); the phone assistant's account is listed but
 * has no sign-in to change.
 */

// The admin's areas (admin-front-end src/shared/access.ts, same order and
// names as its menu). An area whose feature isn't in the plan isn't offered.
const AREAS: { area: string; label: string; feature?: string[] }[] = [
  { area: "statistik", label: "Statistik" },
  { area: "bokningar", label: "Bokningar" },
  { area: "bestallningar", label: "Beställningar", feature: ["ordering"] },
  { area: "catering", label: "Catering", feature: ["catering"] },
  { area: "personalliggare", label: "Personalliggare", feature: ["personalliggare"] },
  { area: "telefon", label: "Telefon", feature: ["phoneAgent"] },
  { area: "meny", label: "Meny" },
  { area: "layout", label: "Layout" },
  { area: "personal", label: "Personal" },
  { area: "gaster", label: "Kunder", feature: ["guestCrm"] },
  { area: "presentkort", label: "Presentkort", feature: ["giftCards"] },
  { area: "evenemang", label: "Evenemang", feature: ["events"] },
  { area: "marknadsforing", label: "Marknadsföring", feature: ["marketing", "metaAds", "googleBusiness", "socialPosting"] },
];

const ROLE_OPTIONS = [{ value: "staff_user", label: "Staff" }, { value: "owner_user", label: "Owner" }];

function offered(tenant: Tenant, access: StaffAccess): typeof AREAS {
  const on = tenant.entitlements.features as Record<string, boolean | undefined>;
  return AREAS.filter((a) => access.areas.includes(a.area) && (!a.feature || a.feature.some((f) => on[f])));
}

/** The person's areas: the group's, plus their extras, minus their removals. */
function areasOf(access: StaffAccess, sub?: string): string[] {
  const own = (sub && access.users[sub]) || { add: [], remove: [] };
  return access.areas.filter((a) => (access.defaults.includes(a) || own.add.includes(a)) && !own.remove.includes(a));
}

/** What the API stores: only what differs from the group's areas. */
function accessInput(access: StaffAccess, areas: string[]) {
  return {
    add: access.areas.filter((a) => areas.includes(a) && !access.defaults.includes(a)),
    remove: access.defaults.filter((a) => !areas.includes(a)),
    version: access.version,
  };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function userState(u: TenantUser): { label: string; cls: string } {
  if (u.system) return { label: "System", cls: "provisioning" };
  if ((u.status ?? "active") !== "active") return { label: "Disabled", cls: "suspended" };
  if (u.invited) return { label: "Invited", cls: "provisioning" };
  return { label: "Active", cls: "active" };
}

/** The day only ("1 Sept 2026"): the table sits in a half-width card. */
function fmtDay(iso?: string) {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "-";
}

const SYSTEM_INFO = "The phone assistant books with this account. It has no email or password, so it can't be invited, edited, disabled or removed. It follows the phone assistant, which the restaurant turns on or off on the Telefon page in the admin app.";

export function UsersTab({ tenant, locations, refreshed = 0 }: { tenant: Tenant; locations: Location[]; refreshed?: number }) {
  const list = useLoad(() => api.users(tenant.tenantId), [tenant.tenantId]);
  const [retrying, setRetrying] = useState(false);
  const retry = async () => { setRetrying(true); await list.reload(); setRetrying(false); };
  // Only a Refresh pressed after this tab opened, and only after a failed load.
  const seenRefresh = useRef(refreshed);
  useEffect(() => {
    if (refreshed === seenRefresh.current) return;
    seenRefresh.current = refreshed;
    if (!list.data && list.error) void retry();
  }, [refreshed]); // eslint-disable-line react-hooks/exhaustive-deps
  const row = useAction();
  const [editing, setEditing] = useState<TenantUser | null>(null);
  const [removing, setRemoving] = useState<TenantUser | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const locked = tenant.status === "offboarding" || tenant.status === "offboarded";
  const users = list.data?.users;
  const access = list.data?.access ?? null;
  const activeOwners = (users ?? []).filter((u) => u.role === "owner_user" && !u.system && (u.status ?? "active") === "active").length;
  const locationName = (id?: string) => locations.find((l) => l.locationId === id)?.name;
  const reload = () => void list.reload();

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setDone(null);
    if (await row.run(fn) !== undefined) { setDone(msg); reload(); }
  };

  return (
    <div className="cols">
      <Card title="Sign-in accounts" info="Owners have every area of the admin app. Staff work at one location and open the areas ticked for them. The restaurant's owners can also manage staff in the admin app (Personal).">
        <ErrorNotice error={list.error} onRetry={() => void retry()} />
        <ErrorNotice error={row.error} />
        {done && <Notice kind="ok">{done}</Notice>}
        {(list.loading || retrying) && !list.data ? <SkelPage label="Loading users"><SkelRows n={3} cols={4} /></SkelPage> : users && (
        <div className="table-wrap">
        <table className="table users-table">
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Since</th><th className="right"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {users.map((u) => {
              const owner = u.role === "owner_user";
              const s = userState(u);
              const active = (u.status ?? "active") === "active";
              const lastOwner = owner && active && activeOwners <= 1;
              const who = u.name || u.email || "this account";
              return (
              <tr key={u.cognitoSub}>
                <td className="cell-title">
                  {u.name || u.email}
                  {u.system ? <div className="muted small">No sign-in <InfoTip label="About the phone assistant's account">{SYSTEM_INFO}</InfoTip></div>
                    : u.name && <div className="muted small users-table__email">{u.email}</div>}
                </td>
                <td className="cell-fact" data-label="Role">
                  {owner ? "Owner" : "Staff"}
                  {!owner && locationName(u.locationId) && <div className="muted small">{locationName(u.locationId)}</div>}
                </td>
                <td className="cell-badge" data-label="Status"><span className={`status status--${s.cls}`}>{s.label}</span></td>
                <td className="small cell-fact users-table__since" data-label="Since">{fmtDay(u.createdAt)}</td>
                <td className="right">
                  {!u.system && !locked && (
                    <RowActions label={`Actions for ${who}`}>
                      <button type="button" className="row-action" onClick={() => { setDone(null); setEditing(u); }}>Edit</button>
                      {u.invited && active && (
                        <button type="button" className="row-action" disabled={row.busy}
                                onClick={() => act(() => api.resendUserInvite(tenant.tenantId, u.cognitoSub), `Invite sent again to ${u.email}.`)}>
                          Resend invite
                        </button>
                      )}
                      {active ? (
                        <button type="button" className="row-action" disabled={row.busy || lastOwner}
                                title={lastOwner ? "The only active owner. Invite another owner first." : undefined}
                                onClick={() => act(() => api.disableUser(tenant.tenantId, u.cognitoSub), `${who} is disabled and signed out.`)}>
                          Disable
                        </button>
                      ) : (
                        <button type="button" className="row-action" disabled={row.busy}
                                onClick={() => act(() => api.enableUser(tenant.tenantId, u.cognitoSub), `${who} can sign in again.`)}>
                          Enable
                        </button>
                      )}
                      <button type="button" className="row-action row-action--danger" disabled={row.busy || lastOwner}
                              title={lastOwner ? "The only active owner. Invite another owner first." : undefined}
                              onClick={() => { setDone(null); setRemoving(u); }}>
                        Remove
                      </button>
                    </RowActions>
                  )}
                </td>
              </tr>
              );
            })}
            {users.length === 0 && <tr><td colSpan={5} className="empty">No users yet.</td></tr>}
          </tbody>
        </table>
        </div>
        )}
      </Card>
      {!locked && <InviteCard tenant={tenant} locations={locations} access={access} onInvited={(msg) => { setDone(msg); reload(); }} />}
      {editing && (
        <EditUser tenant={tenant} user={editing} locations={locations} access={access}
                  lastOwner={editing.role === "owner_user" && (editing.status ?? "active") === "active" && activeOwners <= 1}
                  onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); setDone(msg); reload(); }} />
      )}
      {removing && (
        <RemoveUser tenantId={tenant.tenantId} user={removing} onClose={() => setRemoving(null)}
                    onRemoved={() => { const e = removing.email; setRemoving(null); setDone(`${e} was removed.`); reload(); }} />
      )}
    </div>
  );
}

function locationOptions(locations: Location[]) {
  return locations.map((l) => ({ value: l.locationId, label: l.name }));
}

/** The areas as ticks; staff only. Unavailable while the customer isn't active. */
function Permissions({ tenant, access, value, onChange, saved }: {
  tenant: Tenant; access: StaffAccess | null; value: string[]; onChange: (areas: string[]) => void; saved?: string[];
}) {
  if (!access) {
    return <p className="muted small">Permissions can be set while the customer is active.</p>;
  }
  return (
    <fieldset className="areas">
      <legend className="field__label">Permissions <InfoTip label="About permissions">
        Ticked areas of the admin app open for this person. The restaurant's own defaults are ticked for a new staff user.
      </InfoTip></legend>
      <div className="areas__grid">
        {offered(tenant, access).map((a) => (
          <label key={a.area} className={`areas__item${saved && saved.includes(a.area) !== value.includes(a.area) ? " areas__item--changed" : ""}`}>
            <input type="checkbox" checked={value.includes(a.area)}
                   onChange={(e) => onChange(e.target.checked ? [...value, a.area] : value.filter((x) => x !== a.area))} />
            <span>{a.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function InviteCard({ tenant, locations, access, onInvited }: {
  tenant: Tenant; locations: Location[]; access: StaffAccess | null; onInvited: (msg: string) => void;
}) {
  const empty = { role: "staff_user" as UserRole, name: "", email: "", phone: "", locationId: locations.length === 1 ? locations[0].locationId : "" };
  const [f, setF] = useState(empty);
  const [areas, setAreas] = useState<string[] | null>(null);
  const a = useAction();
  const staff = f.role === "staff_user";
  const defaults = access ? areasOf(access) : [];
  const chosen = areas ?? defaults;
  // The ticked areas count too (as a set): ticking one back is clean again.
  const dirty = useDirty({ f, areas: [...chosen].sort() }, { f: empty, areas: [...defaults].sort() });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = staff
      ? { role: f.role, name: f.name.trim(), email: f.email.trim(), phone: f.phone, locationId: f.locationId,
          ...(access && areas ? { access: accessInput(access, areas) } : {}) }
      : { role: f.role, name: f.name.trim(), email: f.email.trim() };
    if (await a.run(() => api.createUser(tenant.tenantId, body))) {
      onInvited(`Invite sent to ${f.email.trim()}.`);
      setF(empty);
      setAreas(null);
    }
  };
  const ready = f.name.trim() && f.email.trim() && (!staff || (f.phone && f.locationId));
  return (
    <Card title="Invite a user">
      <form noValidate onSubmit={submit} className="stack">
        <ErrorNotice error={a.error && !Object.keys(a.fields).length ? a.error : null} />
        <Field label="Role" required error={a.fields.role}>
          <Select value={f.role} onChange={(v) => setF({ ...f, role: v as UserRole })} options={ROLE_OPTIONS} aria-label="Role" />
        </Field>
        <Field label="Name" required error={a.fields.name}>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} />
        </Field>
        <Field label="Business email" required error={a.fields.email} hint="Gets a temporary password by email">
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={254} />
        </Field>
        {staff && <>
          <Field label="Mobile number" required error={a.fields.phone}>
            <PhoneInput className="input" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
          </Field>
          <Field label="Location" required error={a.fields.locationId}>
            <Select value={f.locationId} onChange={(v) => setF({ ...f, locationId: v })} options={locationOptions(locations)}
                    placeholder="Choose a location" aria-label="Location" />
          </Field>
          <Permissions tenant={tenant} access={access} value={chosen} onChange={setAreas} />
        </>}
        <SaveBar label="Send invite" busy={a.busy} busyLabel="Inviting…" done={a.done} doneLabel="Invite sent"
                 dirty={dirty.dirty} disabled={!ready} failed={!!a.error}
                 onDiscard={() => { setF(dirty.base.f); setAreas(null); a.setError(null); }} />
      </form>
    </Card>
  );
}

function EditUser({ tenant, user, locations, access, lastOwner, onClose, onSaved }: {
  tenant: Tenant; user: TenantUser; locations: Location[]; access: StaffAccess | null; lastOwner: boolean;
  onClose: () => void; onSaved: (msg: string) => void;
}) {
  const savedAreas = access ? areasOf(access, user.cognitoSub) : [];
  const start = { role: user.role, name: user.name ?? "", email: user.email ?? "", phone: user.phone ?? "", locationId: user.locationId ?? "" };
  const [f, setF] = useState(start);
  const [areas, setAreas] = useState(savedAreas);
  const a = useAction();
  const dirty = useDirty(f, start);
  const staff = f.role === "staff_user";
  const areasChanged = staff && !!access && !sameSet(areas, savedAreas);
  const changed = dirty.dirty || areasChanged;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (f.role !== start.role) patch.role = f.role;
    if (f.name.trim() !== start.name.trim()) patch.name = f.name.trim();
    if (f.email.trim().toLowerCase() !== start.email.toLowerCase()) patch.email = f.email.trim();
    if (staff && f.phone !== start.phone && f.phone) patch.phone = f.phone;
    if (staff && f.locationId !== start.locationId) patch.locationId = f.locationId;
    if (staff && f.role !== start.role) patch.locationId = f.locationId;
    if (areasChanged && access) patch.access = accessInput(access, areas);
    const r = await a.run(() => api.updateUser(tenant.tenantId, user.cognitoSub, patch));
    if (r) onSaved(r.inviteResent ? `Saved. Invite sent again to ${r.user.email}.` : "Saved.");
  };
  return (
    <Modal title={user.role === "owner_user" ? "Edit owner" : "Edit staff"} onClose={onClose}>
      <form noValidate onSubmit={submit} className="stack">
        <ErrorNotice error={a.error && !Object.keys(a.fields).length ? a.error : null} />
        <Field label="Role" required changed={f.role !== start.role} error={a.fields.role}>
          <Select value={f.role} onChange={(v) => setF({ ...f, role: v as UserRole })} aria-label="Role"
                  options={ROLE_OPTIONS.map((o) => ({ ...o, disabled: lastOwner && o.value === "staff_user" }))}
                  title={lastOwner ? "The only active owner. Invite another owner first." : undefined} />
        </Field>
        <Field label="Name" required changed={f.name.trim() !== start.name.trim()} error={a.fields.name}>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus maxLength={100} />
        </Field>
        <Field label={<>Business email <InfoTip label="About changing the email">
                 Sign-in moves to the new address at once, with no code to confirm. The old address stops working and the
                 person stays signed in. Someone who hasn't signed in yet gets the invite again at the new address.
               </InfoTip></>} required changed={f.email.trim().toLowerCase() !== start.email.toLowerCase()} error={a.fields.email}>
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" maxLength={254} />
        </Field>
        {staff && <>
          <Field label="Mobile number" changed={f.phone !== start.phone} error={a.fields.phone}>
            <PhoneInput className="input" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
          </Field>
          <Field label="Location" required changed={f.locationId !== start.locationId} error={a.fields.locationId}>
            <Select value={f.locationId} onChange={(v) => setF({ ...f, locationId: v })} options={locationOptions(locations)}
                    placeholder="Choose a location" aria-label="Location" />
          </Field>
          <Permissions tenant={tenant} access={access} value={areas} onChange={setAreas} saved={savedAreas} />
        </>}
        <SaveBar busy={a.busy} dirty={changed} failed={!!a.error}
                 disabled={!changed || !f.name.trim() || !f.email.trim() || (staff && !f.locationId)}>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
        </SaveBar>
      </form>
    </Modal>
  );
}

function RemoveUser({ tenantId, user, onClose, onRemoved }: { tenantId: string; user: TenantUser; onClose: () => void; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState("");
  const a = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.deleteUser(tenantId, user.cognitoSub)) !== undefined) onRemoved();
  };
  return (
    <Modal title={user.role === "owner_user" ? "Remove owner" : "Remove staff"} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Notice kind="warn">
          <strong>{user.email}</strong> is signed out and can't sign in to the admin app again. This can't be undone: to
          give access back, invite them again. To pause access instead, use Disable.
        </Notice>
        <ErrorNotice error={a.error} />
        <Field label={`Type ${user.email} to confirm`}>
          <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
        </Field>
        <div className="row">
          <button className="btn btn--danger" disabled={a.busy || confirm.trim().toLowerCase() !== user.email.toLowerCase()}>
            {a.busy ? "Removing…" : "Remove"}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
