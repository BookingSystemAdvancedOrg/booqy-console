import { Avatar } from "../components/Avatar";
import { emailName, getMyAvatar, subscribeMyAvatar } from "../avatar";
import { AvatarLightbox } from "../components/AvatarLightbox";
import { rowAction } from "../components/rowLink";
import { RowActions } from "../components/RowActions";
import { FormEvent, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { ErrorNotice, Field, Modal, Notice, fmtDate, useAction, useLoad } from "../components/ui";
import type { OperatorAccount } from "../types";
import { RefreshButton, SaveButton, useDirty } from "../components/save";
import { SkelPage, SkelTable } from "../components/Skeleton";

function state(o: OperatorAccount): { label: string; cls: string } {
  if (!o.enabled) return { label: "Disabled", cls: "suspended" };
  if (o.status === "FORCE_CHANGE_PASSWORD") return { label: "Invited", cls: "provisioning" };
  return { label: "Active", cls: "active" };
}

export default function OperatorsPage({ me }: { me: string }) {
  const myAvatar = useSyncExternalStore(subscribeMyAvatar, getMyAvatar, getMyAvatar);
  const { data, error, loading, reload } = useLoad(() => api.operators());
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<OperatorAccount | null>(null);
  const [deleting, setDeleting] = useState<OperatorAccount | null>(null);
  const [viewing, setViewing] = useState<OperatorAccount | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const row = useAction();

  const rows = [...(data ?? [])].sort((a, b) => (a.username === me ? -1 : b.username === me ? 1 : a.email.localeCompare(b.email)));
  const activeCount = (data ?? []).filter((o) => o.enabled).length;
  const avatarFor = (o: OperatorAccount) => (o.username === me ? (myAvatar.url ?? o.avatarUrl) : o.avatarUrl);

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
          <RefreshButton reload={reload} />
          <button className="btn btn--primary" onClick={() => setAdding(true)}>+ Add operator</button>
        </div>
      </div>

      <ErrorNotice error={error} />
      <ErrorNotice error={row.error} />
      {done && <Notice kind="ok">{done}</Notice>}

      {loading && !data ? <SkelPage label="Loading operators"><SkelTable rows={4} cols={4} /></SkelPage> : (
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
                  // Every operator may edit every operator: the whole row opens Edit
                  // (click, Enter or Space). The picture opens the lightbox and the
                  // action buttons do their own thing (rowLink.ts skips buttons).
                  <tr key={o.username} className="row-link operator-row" aria-label={`${o.name || o.email}, open to edit`} {...rowAction(() => setEditing(o))}>
                    <td className="strong">
                      <span className="operator-name">
                        <button type="button" className="avatar-btn" aria-label={`Show the profile picture of ${o.name || o.email}`} onClick={() => setViewing(o)}>
                          <Avatar url={avatarFor(o)} name={o.name} email={o.email} size="sm" />
                        </button>
                        {o.name || <span className="operator-name__fallback" title="No name yet">{emailName(o.email)}</span>}
                        {self && <span className="tag">you</span>}
                      </span>
                    </td>
                    <td>{o.email}</td>
                    <td><span className={`status status--${s.cls}`}>{s.label}</span></td>
                    <td className="muted small">{fmtDate(o.createdAt)}</td>
                    <td className="right">
                      <RowActions label={`Actions for ${o.email}`}>
                        <button className="row-action" onClick={() => setEditing(o)}>Edit</button>
                        {o.status === "FORCE_CHANGE_PASSWORD" && o.enabled && (
                          <button className="row-action" disabled={row.busy}
                                  onClick={() => act(() => api.resendInvite(o.username), `Invite sent again to ${o.email}.`)}>
                            Resend invite
                          </button>
                        )}
                        {o.enabled ? (
                          <button className="row-action" disabled={row.busy || self || lastActive}
                                  title={self ? "You can't disable yourself" : lastActive ? "The last active operator" : undefined}
                                  onClick={() => act(() => api.updateOperator(o.username, { enabled: false }),
                                                     `${o.email} is disabled and signed out.`)}>
                            Disable
                          </button>
                        ) : (
                          <button className="row-action" disabled={row.busy}
                                  onClick={() => act(() => api.updateOperator(o.username, { enabled: true }),
                                                     `${o.email} can sign in again.`)}>
                            Enable
                          </button>
                        )}
                        <button className="row-action row-action--danger" disabled={row.busy || self || lastActive}
                                title={self ? "You can't delete yourself" : lastActive ? "The last active operator" : undefined}
                                onClick={() => setDeleting(o)}>
                          Delete
                        </button>
                      </RowActions>
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
      {viewing && (
        <AvatarLightbox url={avatarFor(viewing)} name={viewing.name} email={viewing.email} onClose={() => setViewing(null)} />
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
  const dirty = useDirty({ email, name }, { email: "", name: "" });
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
          <SaveButton label="Send invite" busy={a.busy} busyLabel="Sending invite…" dirty={dirty.dirty} />
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function EditOperator({ op, onClose, onSaved }: { op: OperatorAccount; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(op.name);
  const a = useAction();
  const dirty = useDirty(name.trim(), op.name);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.updateOperator(op.username, { name: name.trim() }))) onSaved();
  };
  return (
    <Modal title="Edit operator" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <ErrorNotice error={a.error && !Object.keys(a.fields).length ? a.error : null} />
        <Field label="Name" required changed={dirty.dirty} error={a.fields.name}
               hint={op.name ? undefined : "No name yet. Add one so everyone sees who this is."}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100}
                 placeholder={op.name ? undefined : "Add a name"} />
        </Field>
        <Field label="Email" hint="The email is the sign-in name and can't be changed. Add a new operator instead.">
          <input className="input" value={op.email} disabled />
        </Field>
        <div className="row">
          <SaveButton label="Save" busy={a.busy} dirty={dirty.dirty} />
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
