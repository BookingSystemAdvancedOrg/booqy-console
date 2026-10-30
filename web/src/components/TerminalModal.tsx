import { FormEvent, useState } from "react";
import { api, ApiError } from "../api";
import { ErrorNotice, Field, Modal, Notice, Printing, useAction, useLoad } from "./ui";
import type { Location, Tenant, TerminalAddress, TerminalReader } from "../types";
import { POSTAL_CODE_INPUT, formatPostalCode, postalCodeDigits } from "../postalCode";
import { CheckMark, SaveButton, useDirty, useFlash } from "./save";

/** Card terminals (Stripe Terminal) for one restaurant location: enable, pair
 *  readers, remove readers. Everything lives on the restaurant's own Stripe
 *  account, so in-person payments go to the restaurant. */
export default function TerminalModal({ tenant, location, goPlan, onClose }: {
  tenant: Tenant; location: Location; goPlan: () => void; onClose: () => void;
}) {
  const { data, error, loading, reload } = useLoad(() => api.terminal(tenant.tenantId, location.locationId),
                                                   [tenant.tenantId, location.locationId]);
  const stripeReady = !!tenant.stripe?.chargesEnabled || !!location.stripeAccountId;
  const [editing, setEditing] = useState(false);
  const [saved, flashSaved] = useFlash();

  return (
    <Modal title={`Card terminals - ${location.name}`} onClose={onClose}>
      <div className="stack">
        <ErrorNotice error={error} />
        {loading && !data && <Printing inline />}

        {data && !data.inPlan && (
          <Notice kind="warn">
            Card terminals aren't in {tenant.name}'s plan. Turn on the <code>terminal</code> feature in{" "}
            <button className="link" onClick={() => { onClose(); goPlan(); }}>Plan</button> first.
          </Notice>
        )}
        {data && data.inPlan && !data.enabled && !stripeReady && (
          <Notice kind="warn">
            The restaurant hasn't finished Stripe onboarding yet (charges not enabled). Send them the onboarding link
            from the <strong>Payments</strong> tab first.
          </Notice>
        )}

        {data && !data.enabled && data.inPlan && (
          <EnableForm tenant={tenant} location={location} onDone={reload} />
        )}

        {data?.enabled && data.terminal && (
          <>
            <section>
              <h3 style={{ marginBottom: 6 }}>Terminal location</h3>
              {!editing ? (
                <p className="small" style={{ margin: 0 }}>
                  <strong>{data.terminal.displayName}</strong> · {data.terminal.address.line1},{" "}
                  {formatPostalCode(data.terminal.address.postalCode)} {data.terminal.address.city}
                  <button className="link" onClick={() => setEditing(true)}>Change address</button>
                  {saved && <span className="saved-stamp" role="status"><CheckMark />Saved</span>}
                  <br />
                  <span className="muted mono">{data.terminal.locationId} on {data.terminal.accountId}</span>
                </p>
              ) : (
                <EditAddress tenant={tenant} location={location} current={data.terminal.address}
                             displayName={data.terminal.displayName}
                             onDone={() => { setEditing(false); flashSaved(); void reload(); }} onCancel={() => setEditing(false)} />
              )}
            </section>
            <Readers tenant={tenant} location={location} readers={data.readers} onChanged={reload} onRegistered={onClose} />
          </>
        )}
      </div>
    </Modal>
  );
}

type AddrForm = TerminalAddress & { displayName?: string };

function AddressFields({ v, set, fields, changed = () => false }: {
  v: AddrForm;
  set: (v: AddrForm) => void;
  fields: Record<string, string>;
  changed?: (key: keyof AddrForm) => boolean;
}) {
  return (
    <div className="grid">
      <Field label="Name on receipts / in Stripe" changed={changed("displayName")} error={fields.displayName} hint="Defaults to the location name">
        <input className="input" value={v.displayName ?? ""} onChange={(e) => set({ ...v, displayName: e.target.value })} />
      </Field>
      <Field label="Street address" required changed={changed("line1")} error={fields.line1}>
        <input className="input" value={v.line1} onChange={(e) => set({ ...v, line1: e.target.value })} />
      </Field>
      <Field label="Postal code" required changed={changed("postalCode")} error={fields.postalCode}>
        <input className="input mono" {...POSTAL_CODE_INPUT} value={v.postalCode} onChange={(e) => set({ ...v, postalCode: formatPostalCode(e.target.value) })} />
      </Field>
      <Field label="City" required changed={changed("city")} error={fields.city}>
        <input className="input" value={v.city} onChange={(e) => set({ ...v, city: e.target.value })} />
      </Field>
    </div>
  );
}

function EnableForm({ tenant, location, onDone }: { tenant: Tenant; location: Location; onDone: () => void }) {
  // Pre-filled from the customer's company address - edit it if this restaurant is elsewhere.
  const [v, set] = useState<AddrForm>({
    displayName: location.name,
    line1: tenant.address?.street ?? "",
    postalCode: formatPostalCode(tenant.address?.postalCode ?? ""),
    city: tenant.address?.city ?? "",
  });
  const a = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { ...v, postalCode: postalCodeDigits(v.postalCode) };
    if (await a.run(() => api.enableTerminal(tenant.tenantId, location.locationId, body))) onDone();
  };
  return (
    <form onSubmit={submit} className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Registers this restaurant's address with Stripe (required for card readers in Sweden). Readers paired to it take
        payments into <strong>the restaurant's</strong> Stripe account.
      </p>
      <p className="small" style={{ margin: 0 }}>Location address on file: <em>{location.address}</em></p>
      <ErrorNotice error={a.error && !Object.keys(a.fields).length ? a.error : null} />
      <AddressFields v={v} set={set} fields={a.fields} />
      <div className="row">
        <SaveButton label="Enable card terminals" busy={a.busy} busyLabel="Enabling…" />
      </div>
    </form>
  );
}

function EditAddress({ tenant, location, current, displayName, onDone, onCancel }: {
  tenant: Tenant; location: Location; current: TerminalAddress; displayName: string; onDone: () => void; onCancel: () => void;
}) {
  const initial: AddrForm = { ...current, postalCode: formatPostalCode(current.postalCode), displayName };
  const [v, set] = useState<AddrForm>(initial);
  const a = useAction();
  const dirty = useDirty(v, initial);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { line1: v.line1, postalCode: postalCodeDigits(v.postalCode), city: v.city, displayName: v.displayName };
    if (await a.run(() => api.updateTerminal(tenant.tenantId, location.locationId, body))) onDone();
  };
  return (
    <form onSubmit={submit} className="stack">
      <ErrorNotice error={a.error && !Object.keys(a.fields).length ? a.error : null} />
      <AddressFields v={v} set={set} fields={a.fields} changed={dirty.changed} />
      <div className="row">
        <SaveButton small label="Save address" busy={a.busy} dirty={dirty.dirty} />
        <button type="button" className="btn btn--ghost btn--small" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export const DEVICE: Record<string, string> = {
  stripe_s700: "Stripe Reader S700", stripe_s710: "Stripe Reader S710", bbpos_wisepos_e: "BBPOS WisePOS E",
  bbpos_wisepad3: "BBPOS WisePad 3", simulated_wisepos_e: "Simulated WisePOS E (test)",
  mobile_phone_reader: "Tap to Pay (phone)",
};

function Readers({ tenant, location, readers, onChanged, onRegistered }: {
  tenant: Tenant; location: Location; readers: TerminalReader[]; onChanged: () => void;
  /** After a successful registration: back to the location list. */
  onRegistered: () => void;
}) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const add = useAction();
  const rm = useAction();
  const [confirm, setConfirm] = useState<TerminalReader | null>(null);
  const dirty = useDirty({ code, label }, { code: "", label: "" });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await add.run(() => api.registerReader(tenant.tenantId, location.locationId, code.trim(), label.trim()))) {
      setCode("");
      setLabel("");
      onRegistered();
    }
  };

  return (
    <section className="stack">
      <h3 style={{ margin: 0 }}>Card readers</h3>
      <ErrorNotice error={rm.error} />
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Model</th><th>Status</th><th /></tr></thead>
          <tbody>
            {readers.length === 0 && <tr><td colSpan={4} className="empty">No readers yet - register one below.</td></tr>}
            {readers.map((r) => (
              <tr key={r.id}>
                <td className="strong">{r.label}<div className="muted small mono">{r.serial_number ?? r.id}</div></td>
                <td className="small">{DEVICE[r.device_type] ?? r.device_type}</td>
                <td>
                  <span className={`status status--${r.status === "online" ? "active" : "suspended"}`}>
                    {r.status === "online" ? "Online" : "Offline"}
                  </span>
                </td>
                <td className="right">
                  {confirm?.id === r.id ? (
                    <>
                      <SaveButton kind="danger" small type="button" label="Remove" busy={rm.busy} busyLabel="Removing…" hint={false}
                                  onClick={async () => {
                                    if (await rm.run(() => api.removeReader(tenant.tenantId, location.locationId, r.id))) {
                                      setConfirm(null);
                                      onChanged();
                                    }
                                  }} />
                      <button className="btn btn--ghost btn--small" onClick={() => setConfirm(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn btn--ghost btn--small danger" onClick={() => setConfirm(r)}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={submit} className="card" style={{ padding: "12px 14px", margin: 0 }}>
        <strong className="small">Register a reader</strong>
        <p className="muted small" style={{ margin: "4px 0 8px" }}>
          On the reader: Settings → Generate pairing code. The code expires after a few minutes. In test mode, use{" "}
          <code>simulated-wpe</code> for a simulated reader.
        </p>
        {add.error && !(add.error instanceof ApiError && Object.keys(add.fields).length) ? <ErrorNotice error={add.error} /> : null}
        <div className="grid">
          <Field label="Pairing code" required error={add.fields.registrationCode}>
            <input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. sepia-cerulean-aqua" />
          </Field>
          <Field label="Name" required error={add.fields.label} hint="e.g. Counter 1, Bar">
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          </Field>
        </div>
        <SaveButton small label="Register reader" busy={add.busy} busyLabel="Registering…" dirty={dirty.dirty} disabled={!code.trim() || !label.trim()} />
      </form>
    </section>
  );
}
