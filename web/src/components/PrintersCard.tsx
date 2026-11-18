import { FormEvent, useState } from "react";
import { api } from "../api";
import { Card, ErrorNotice, Field, Modal, Notice, useAction, useLoad } from "./ui";
import { Select } from "./Select";
import { CopyButton } from "./CopyButton";
import { SaveButton, useDirty, useFlash } from "./save";
import { SkelPage, SkelRows } from "./Skeleton";
import { InfoTip } from "./StepFlow";
import { isProd } from "../testSites";
import type { AddedPrinter, Location, LocationPrinters, Printer, PrinterKind, PrinterStatus, PrinterSummary, Tenant } from "../types";
import "./printers.css";

export const KIND_LABEL: Record<PrinterKind, string> = { kok: "Kitchen", dryck: "Drinks", annat: "Other" };
const KIND_OPTIONS = (Object.keys(KIND_LABEL) as PrinterKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }));
export const PRINTER_STATUS_TEXT: Record<PrinterStatus, string> = {
  ok: "Connected", offline: "Offline", none: "No printers", skipped: "Skipped",
};

/** "Connected", "1 offline", "No printers", "Skipped": a location's or a customer's printers at a glance. */
export function PrinterBadge({ status, offline = 0 }: { status: PrinterStatus | null; offline?: number }) {
  if (!status) return <span className="muted">-</span>;
  const text = status === "offline" && offline > 0 ? `${offline} offline` : PRINTER_STATUS_TEXT[status];
  return <span className={`status status--printers-${status}`}>{text}</span>;
}

/** The customer list's Printers column. */
export function PrinterCell({ summary }: { summary: PrinterSummary | null | undefined | "unknown" }) {
  if (summary === null) return <span className="muted small">…</span>;
  if (summary === "unknown") return <span className="muted" title="Printers did not load" aria-label="Printers did not load">?</span>;
  if (!summary) return <span className="muted">-</span>;
  return <PrinterBadge status={summary.status} offline={summary.offline} />;
}

/** A printer is offline: the compact phone list shows the badge beside the status too. */
export function printerAlert(summary: PrinterSummary | null | undefined | "unknown"): boolean {
  return !!summary && summary !== "unknown" && summary.status === "offline";
}

/** "2 min ago", "3 h ago", then the date: when the printer last asked for work. */
export function seenText(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "Never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

type Edit = { location: Location; printer: Printer | null };

export function PrintersCard({ tenant, locations }: { tenant: Tenant; locations: Location[] }) {
  const data = useLoad(() => api.tenantPrinters(tenant.tenantId), [tenant.tenantId]);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [remove, setRemove] = useState<Edit | null>(null);
  const [saved, flashSaved] = useFlash();
  const [savedLabel, setSavedLabel] = useState("Saved");
  const changed = (label: string) => { setSavedLabel(label); flashSaved(); void data.reload(); };
  const byId = new Map((data.data?.locations ?? []).map((l) => [l.locationId, l]));
  return (
    <Card title="Printers" saved={saved} savedLabel={savedLabel}
          info="Each location's kitchen printers, as the restaurant set them up in the admin app (Inställningar, Kvittoskrivare). Connected: the printer asked for work in the last 2 minutes. Changes here are logged in Activity.">
      <ErrorNotice error={data.error} onRetry={() => void data.reload()} />
      {data.loading && !data.data ? <SkelPage label="Loading printers"><SkelRows n={2} cols={4} /></SkelPage> : data.data && (
        <div className="printers">
          {locations.map((l) => (
            <LocationBlock key={l.locationId} tenant={tenant} location={l} state={byId.get(l.locationId)}
                           onAdd={() => setEdit({ location: l, printer: null })}
                           onEdit={(p) => setEdit({ location: l, printer: p })}
                           onRemove={(p) => setRemove({ location: l, printer: p })} />
          ))}
          {locations.length === 0 && <p className="empty">No locations yet.</p>}
        </div>
      )}
      {edit && (edit.printer
        ? <EditPrinterModal tenant={tenant} location={edit.location} printer={edit.printer} onClose={() => setEdit(null)}
                            onSaved={() => { setEdit(null); changed("Saved"); }} />
        : <AddPrinterModal tenant={tenant} location={edit.location} onClose={() => setEdit(null)} onAdded={() => changed("Added")} />)}
      {remove?.printer && (
        <RemovePrinterModal tenant={tenant} location={remove.location} printer={remove.printer} onClose={() => setRemove(null)}
                            onDone={() => { setRemove(null); changed("Removed"); }} />
      )}
    </Card>
  );
}

function LocationBlock({ tenant, location, state, onAdd, onEdit, onRemove }: {
  tenant: Tenant; location: Location; state: LocationPrinters | undefined;
  onAdd: () => void; onEdit: (p: Printer) => void; onRemove: (p: Printer) => void;
}) {
  const printers = state?.printers ?? [];
  const offline = printers.filter((p) => !p.online).length;
  return (
    <section className="printers__loc" aria-label={`Printers at ${location.name}`}>
      <header className="printers__head">
        <span className="printers__name strong">{location.name}</span>
        <PrinterBadge status={state?.status ?? null} offline={offline} />
        <button className="btn btn--ghost btn--small printers__add" onClick={onAdd}>+ Add printer</button>
      </header>
      {printers.length > 0 ? (
        <table className="table printers__table">
          <thead><tr><th>Printer</th><th>Kind</th><th>Connected</th><th>Last seen</th><th /></tr></thead>
          <tbody>
            {printers.map((p) => (
              <tr key={p.deviceId}>
                <td className="cell-title strong">{p.name}{p.simulated && <span className="muted small"> · simulated</span>}</td>
                <td className="cell-fact" data-label="Kind">{KIND_LABEL[p.kind] ?? p.kind}</td>
                <td className="cell-fact" data-label="Connected">{p.online ? <span className="ok">Yes</span> : <span className="printers__no">No</span>}</td>
                <td className="cell-fact small" data-label="Last seen">{p.simulated ? <span className="muted">-</span> : seenText(p.lastSeenAt)}</td>
                <td className="right printers__actions">
                  <TestButton tenant={tenant} location={location} printer={p} />
                  <button className="btn btn--ghost btn--small" onClick={() => onEdit(p)}>Edit</button>
                  <button className="btn btn--ghost btn--small danger" onClick={() => onRemove(p)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small printers__empty">
          {state?.status === "skipped" ? <>Owner chose "Inga skrivare än" <InfoTip label="Skipped">The owner skipped the printer step in Kom igång; the step stays open in the admin app until a printer is added.</InfoTip></> : "No printers yet."}
        </p>
      )}
    </section>
  );
}

function TestButton({ tenant, location, printer }: { tenant: Tenant; location: Location; printer: Printer }) {
  const a = useAction();
  return (
    <span className="printers__test">
      <SaveButton type="button" kind="ghost" small label="Test print" busy={a.busy} busyLabel="Sending…" done={a.done} doneLabel="Sent"
                  allowClean hint={false} onClick={() => void a.run(() => api.testPrinter(tenant.tenantId, location.locationId, printer.deviceId))} />
      {!!a.error && <ErrorNotice error={a.error} />}
    </span>
  );
}

function AddPrinterModal({ tenant, location, onClose, onAdded }: { tenant: Tenant; location: Location; onClose: () => void; onAdded: () => void }) {
  const initial = { name: "", kind: "kok" as PrinterKind, protocol: "star" as "star" | "epson" | "sim" };
  const [f, setF] = useState(initial);
  const [added, setAdded] = useState<AddedPrinter | null>(null);
  const a = useAction();
  const dirty = useDirty(f, initial);
  const close = () => { if (added || !dirty.dirty || window.confirm("Close without saving?")) onClose(); };
  const protocols = [{ value: "star", label: "Star (CloudPRNT)" }, { value: "epson", label: "Epson (Server Direct Print)" },
    ...(isProd() ? [] : [{ value: "sim", label: "Simulated (dev)" }])];

  async function save(e: FormEvent) {
    e.preventDefault();
    const res = await a.run(() => api.addPrinter(tenant.tenantId, location.locationId, { name: f.name.trim(), kind: f.kind, protocol: f.protocol }));
    if (res) { setAdded(res); onAdded(); }
  }

  if (added) return (
    <Modal title={`${added.printer.name} added`} onClose={onClose}>
      {added.secret ? (
        <>
          <Notice kind="warn">Shown once. Read it to the restaurant now.</Notice>
          <dl className="dl printers__creds">
            <dt>Server URL</dt><dd><span className="mono">{added.serverUrl}</span> {added.serverUrl && <CopyButton text={added.serverUrl} />}</dd>
            <dt>Username</dt><dd><span className="mono">{added.username}</span> {added.username && <CopyButton text={added.username} />}</dd>
            <dt>Password</dt><dd><span className="mono">{added.secret}</span> <CopyButton text={added.secret} /></dd>
          </dl>
        </>
      ) : <Notice kind="ok">Simulated: nothing to set up. Its tickets show in the admin app.</Notice>}
      <div className="row"><button className="btn btn--primary" onClick={onClose}>Done</button></div>
    </Modal>
  );

  return (
    <Modal title={`Add printer to ${location.name}`} onClose={close}>
      <form onSubmit={save} noValidate>
        <ErrorNotice error={a.error} />
        <div className="grid">
          <Field label="Name" required error={a.fields.name}>
            <input className="input" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Kind" required error={a.fields.kind}>
            <Select aria-label="Kind" value={f.kind} options={KIND_OPTIONS} onChange={(v) => setF({ ...f, kind: v as PrinterKind })} />
          </Field>
          <Field label="Printer type" error={a.fields.protocol}>
            <Select aria-label="Printer type" value={f.protocol} options={protocols} onChange={(v) => setF({ ...f, protocol: v as typeof f.protocol })} />
          </Field>
        </div>
        <div className="row">
          <SaveButton label="Add printer" busyLabel="Adding…" busy={a.busy} dirty={dirty.dirty} disabled={!f.name.trim()} />
          <button type="button" className="btn btn--ghost" onClick={close}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function EditPrinterModal({ tenant, location, printer, onClose, onSaved }: {
  tenant: Tenant; location: Location; printer: Printer; onClose: () => void; onSaved: () => void;
}) {
  const initial = { name: printer.name, kind: printer.kind };
  const [f, setF] = useState(initial);
  const a = useAction();
  const dirty = useDirty(f, initial);
  const close = () => { if (!dirty.dirty || window.confirm("Close without saving?")) onClose(); };
  async function save(e: FormEvent) {
    e.preventDefault();
    const patch: { name?: string; kind?: PrinterKind } = {};
    if (f.name.trim() !== printer.name) patch.name = f.name.trim();
    if (f.kind !== printer.kind) patch.kind = f.kind;
    if (!Object.keys(patch).length) return onClose();
    if (await a.run(() => api.updatePrinter(tenant.tenantId, location.locationId, printer.deviceId, patch))) onSaved();
  }
  return (
    <Modal title={`Edit ${printer.name}`} onClose={close}>
      <form onSubmit={save} noValidate>
        <ErrorNotice error={a.error} />
        <div className="grid">
          <Field label="Name" required changed={dirty.changed("name")} error={a.fields.name}>
            <input className="input" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Kind" required changed={dirty.changed("kind")} error={a.fields.kind}>
            <Select aria-label="Kind" value={f.kind} options={KIND_OPTIONS} onChange={(v) => setF({ ...f, kind: v as PrinterKind })} />
          </Field>
        </div>
        <div className="row">
          <SaveButton label="Save" busy={a.busy} dirty={dirty.dirty} disabled={!f.name.trim()} />
          <button type="button" className="btn btn--ghost" onClick={close}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function RemovePrinterModal({ tenant, location, printer, onClose, onDone }: {
  tenant: Tenant; location: Location; printer: Printer; onClose: () => void; onDone: () => void;
}) {
  const a = useAction();
  return (
    <Modal title={`Remove ${printer.name}?`} onClose={onClose}>
      <p>It stops printing at once at {location.name}. To use it again, add it again and enter the new details on the printer.</p>
      <ErrorNotice error={a.error} />
      <div className="row">
        <SaveButton kind="danger" type="button" label="Remove printer" busy={a.busy} busyLabel="Removing…" allowClean hint={false}
                    onClick={async () => { if (await a.run(() => api.removePrinter(tenant.tenantId, location.locationId, printer.deviceId))) onDone(); }} />
        <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
