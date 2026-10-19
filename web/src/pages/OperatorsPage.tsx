import { FormEvent, useState } from "react";
import { api } from "../api";
import { ErrorNotice, Field, Modal, Notice, fmtDate, useAction, useLoad } from "../components/ui";
import type { OperatorAccount } from "../types";

function state(o: OperatorAccount): { label: string; cls: string } {
  if (!o.enabled) return { label: "Disabled", cls: "suspended" };
  if (o.status === "FORCE_CHANGE_PASSWORD") return { label: "Invited", cls: "provisioning" };
  return { label: "Active", cls: "active" };
}

export default function OperatorsPage({ me }: { me: string }) {
  const { data, error, loading, reload } = useLoad(() => api.operators());
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<OperatorAccount | null>(null);
  const [deleting, setDeleting] = useState<OperatorAccount | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const row = useAction();

  const rows = [...(data ?? [])].sort((a, b) => (a.username === me ? -1 : b.username === me ? 1 : a.email.localeCompare(b.email)));
  const activeCount = (data ?? []).filter((o) => o.enabled).length;

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setDone(null);
    const ok = await row.run(fn);
    if (ok !== undefined) {
      setDone(msg);
      await reload();
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Operators</h1>
          <p className="muted">People who can sign in to Booqy Console. Everyone here has the same rights.</p>
        </div>
        <div className="row">
          <button className="btn btn--ghost" onClick={() => reload()}>Refresh</button>
          <button className="btn btn--primary" onClick={() => setAdding(true)}>+ Add operator</button>
        </div>
      </div>

      <ErrorNotice error={error} />
      <ErrorNotice error={row.error} />
      {done && <Notice kind="ok">{done}</Notice>}

      {loading && !data ? <p className="muted">Loading…</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Status</th><th>Added</th><th className="right">Actions</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="empty">No operators.</td></tr>}
              {rows.map((o) => {
                const s = state(o);
                const self = o.username === me;
                const lastActive = o.enabled && activeCount <= 1;
                return (
                  <tr key={o.username}>
                    <td className="strong">{o.name || "-"}{self && <span className="tag">you</span>}</td>
                    <td>{o.email}</td>
                    <td><span className={`status status--${s.cls}`}>{s.label}</span></td>
                    <td className="muted small">{fmtDate(o.createdAt)}</td>
                    <td className="right">
                      <div className="row-actions">
                        <button className="btn btn--small" onClick={() => setEditing(o)}>Edit</button>
                        {o.status === "FORCE_CHANGE_PASSWORD" && o.enabled && (
                          <button className="btn btn--small" disabled={row.busy}
                                  onClick={() => act(() => api.resendInvite(o.username), `Invite sent again to ${o.email}.`)}>
                            Resend invite
                          </button>
                        )}
                        {o.enabled ? (
                          <button className="btn btn--small" disabled={row.busy || self || lastActive}
                                  title={self ? "You can't disable yourself" : lastActive ? "The last active operator" : undefined}
                                  onClick={() => act(() => api.updateOperator(o.username, { enabled: false }),
                                                     `${o.email} is disabled and signed out.`)}>
                            Disable
                          </button>
                        ) : (
                          <button className="btn btn--small" disabled={row.busy}
                                  onClick={() => act(() => api.updateOperator(o.username, { enabled: true }),
                                                     `${o.email} can sign in again.`)}>
                            Enable
                          </button>
                        )}
                        <button className="btn btn--small danger" disabled={row.busy || self || lastActive}
                                title={self ? "You can't delete yourself" : lastActive ? "The last active operator" : undefined}
                                onClick={() => setDeleting(o)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddOperator onClose={() => setAdding(false)}
                     onAdded={async (email) => { setAdding(false); setDone(`Invite sent to ${email}. It's valid for 3 days.`); await reload(); }} />
      )}
      {editing && (
        <EditOperator op={editing} onClose={() => setEditing(null)}
                      onSaved={async () => { setEditing(null); setDone("Saved."); await reload(); }} />
      )}
      {deleting && (
        <DeleteOperator op={deleting} onClose={() => setDeleting(null)}
                        onDeleted={async () => { const e = deleting.email; setDeleting(null); setDone(`${e} was deleted.`); await reload(); }} />
      )}
    </>
  );
}

function AddOperator({ onClose, onAdded }: { onClose: () => void; onAdded: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const a = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run(() => api.createOperator(email.trim(), name.trim()));
    if (r) onAdded(r.operator.email);
  };
  return (
    <Modal title="Add operator" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          They get an email with a temporary password. On first sign-in they choose their own password and set up an
          authenticator app. They'll have the same rights as you, including managing operators.
        </p>
        <ErrorNotice error={a.error && !Object.keys(a.fields).length ? a.error : null} />
        <Field label="Name" required error={a.fields.name}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
        </Field>
        <Field label="Email" required error={a.fields.email}>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="row">
          <button className="btn btn--primary" disabled={a.busy}>{a.busy ? "Sending invite…" : "Send invite"}</button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function EditOperator({ op, onClose, onSaved }: { op: OperatorAccount; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(op.name);
  const a = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.updateOperator(op.username, { name: name.trim() }))) onSaved();
  };
  return (
    <Modal title="Edit operator" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <ErrorNotice error={a.error && !Object.keys(a.fields).length ? a.error : null} />
        <Field label="Name" required error={a.fields.name}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
        </Field>
        <Field label="Email" hint="The email is the sign-in name and can't be changed. Add a new operator instead.">
          <input className="input" value={op.email} disabled />
        </Field>
        <div className="row">
          <button className="btn btn--primary" disabled={a.busy}>{a.busy ? "Saving…" : "Save"}</button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteOperator({ op, onClose, onDeleted }: { op: OperatorAccount; onClose: () => void; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState("");
  const a = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.deleteOperator(op.username))) onDeleted();
  };
  return (
    <Modal title="Delete operator" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <Notice kind="warn">
          <strong>{op.email}</strong> is signed out everywhere and can't sign in again. This can't be undone - to give
          access back, add them as a new operator. To pause access instead, use <em>Disable</em>.
        </Notice>
        <ErrorNotice error={a.error} />
        <Field label={`Type ${op.email} to confirm`}>
          <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
        </Field>
        <div className="row">
          <button className="btn btn--danger" disabled={a.busy || confirm.trim().toLowerCase() !== op.email}>
            {a.busy ? "Deleting…" : "Delete operator"}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}
