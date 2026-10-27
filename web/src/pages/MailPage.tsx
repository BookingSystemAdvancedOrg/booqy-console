import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  Card, ErrorNotice, Field, Modal, Notice, Printing, Status, fmtDate, useAction, useLoad,
} from "../components/ui";
import type { MailTemplate, MailTemplateInput, Newsletter, NewsletterRecipient } from "../types";
import OutboxPage from "./OutboxPage";

// Production is the default and is never labelled; only dev says so.
const IS_DEV = (import.meta.env.VITE_ENVIRONMENT ?? "dev") === "dev";

const TABS = ["Compose", "Sent", "Brand template", "Outbox"] as const;
type Tab = (typeof TABS)[number];

const BODY_HINT =
  "Blank line = new paragraph. Start lines with \"- \" for a list, \"# \" for a heading, **bold** for emphasis. Links are clickable as they are.";

const SAMPLE_SUBJECT = "Nyheter från Booqy";
const SAMPLE_BODY =
  "Hej!\n\nHär är ett exempel på hur ett utskick ser ut med er mall.\n\n# Nytt den här månaden\n\n- Bordsbokning i 3D\n- Beställning vid bordet med QR-kod\n\nLäs mer på https://booqy.se";

/** Calls fn 400 ms after the last change of deps. */
function useDebounced<T>(fn: () => Promise<T>, deps: unknown[], wait = 400) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(0);
  useEffect(() => {
    const id = ++latest.current;
    const timer = window.setTimeout(() => {
      fn().then((v) => { if (id === latest.current) { setValue(v); setError(null); } })
          .catch((e) => { if (id === latest.current) setError(e); });
    }, wait);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { value, error };
}

/** The email as it will arrive, in a sandbox: nothing in it can run. */
function Preview({ html, title }: { html: string | null; title: string }) {
  return (
    <div className="card mail-preview">
      <div className="card__head"><h2>{title}</h2></div>
      <div className="card__body">
        <p className="mail-preview__hint">As the owner sees it</p>
        {html ? <iframe className="mail-preview__frame" title="Email preview" sandbox="" srcDoc={html} /> : <Printing inline label="Rendering" />}
      </div>
    </div>
  );
}

export default function MailPage({ tab: initial }: { tab?: "outbox" }) {
  const [tab, setTab] = useState<Tab>(initial === "outbox" ? "Outbox" : "Compose");
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Mail</h1>
          <p className="muted">News, what's coming and important notices to every restaurant owner - sent from Booqy, replies go to support.</p>
        </div>
      </div>
      <nav className="tabs">
        {TABS.filter((name) => name !== "Outbox" || IS_DEV).map((name) => (
          <button key={name} className={`tab${tab === name ? " tab--on" : ""}`} onClick={() => setTab(name)}>{name}</button>
        ))}
      </nav>
      {sentNotice && <Notice kind="ok">{sentNotice} <button className="link" onClick={() => setSentNotice(null)}>Dismiss</button></Notice>}
      {tab === "Compose" && <Compose onSent={(msg) => { setSentNotice(msg); setTab("Sent"); }} />}
      {tab === "Sent" && <Sent />}
      {tab === "Brand template" && <TemplateEditor />}
      {tab === "Outbox" && IS_DEV && <OutboxPage embedded />}
    </>
  );
}

// ------------------------------------------------------------------ compose
function Compose({ onSent }: { onSent: (message: string) => void }) {
  const template = useLoad(() => api.mailTemplate());
  const recipients = useLoad(() => api.mailRecipients());
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [confirm, setConfirm] = useState(false);
  const test = useAction();
  const send = useAction();
  const [testInfo, setTestInfo] = useState<string | null>(null);
  const preview = useDebounced(() => api.mailPreview({ subject, body }), [subject, body]);
  const ready = subject.trim().length > 0 && body.trim().length > 0;
  const count = recipients.data?.count ?? 0;

  async function sendTest() {
    setTestInfo(null);
    const res = await test.run(() => api.sendNewsletter({ subject: subject.trim(), body: body.trim(), test: true }));
    if (res?.sentTo) setTestInfo(`Test sent to ${res.sentTo}. Check the inbox${IS_DEV ? " (or the Outbox tab in dev)" : ""}.`);
  }

  async function sendAll() {
    const res = await send.run(() => api.sendNewsletter({ subject: subject.trim(), body: body.trim() }));
    if (res?.newsletter) {
      setConfirm(false);
      onSent(`"${res.newsletter.subject}" is on its way to ${res.newsletter.recipientCount} owners.`);
    }
  }

  return (
    <div className="mail-grid">
      <Card title="New message">
        <ErrorNotice error={template.error ?? recipients.error} />
        {template.data && (
          <dl className="mail-meta">
            <dt>From</dt><dd>{template.data.senderName} &lt;{template.data.from}&gt;</dd>
            <dt>Reply-to</dt><dd>{template.data.replyTo}</dd>
            <dt>To</dt>
            <dd>{recipients.data ? `${count} restaurant owner${count === 1 ? "" : "s"} (every active customer)` : <Printing inline label="Counting" />}</dd>
          </dl>
        )}
        <div className="stack">
          <Field label="Subject" required error={test.fields.subject ?? send.fields.subject}>
            <input className="input" value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)}
                   placeholder="Nyheter i Booqy: bordsbokning i 3D" autoFocus />
          </Field>
          <Field label="Message" required hint={BODY_HINT} error={test.fields.body ?? send.fields.body}>
            <textarea className="input mail-body" rows={14} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)}
                      placeholder={"Hej!\n\nHär kommer månadens nyheter…"} />
          </Field>
        </div>
        <ErrorNotice error={test.error ?? send.error} />
        {testInfo && <Notice kind="ok">{testInfo}</Notice>}
        <div className="mail-actions">
          <button type="button" className="btn btn--ghost" disabled={!ready || test.busy} onClick={() => void sendTest()}>
            {test.busy ? "Sending test…" : "Send me a test"}
          </button>
          <button type="button" className="btn btn--primary" disabled={!ready || count === 0 || send.busy} onClick={() => setConfirm(true)}>
            Send to {count} owner{count === 1 ? "" : "s"}
          </button>
          <span className="muted">Sent as plain text and HTML, with the brand template.</span>
        </div>
      </Card>
      <Preview html={preview.value?.html ?? null} title="Preview" />
      {confirm && (
        <Modal title="Send to every owner?" onClose={() => setConfirm(false)}>
          <div className="stack">
            <p>
              <strong>{subject.trim()}</strong> goes to {count} restaurant owner{count === 1 ? "" : "s"} right away, from{" "}
              {template.data?.senderName} &lt;{template.data?.from}&gt;. It can't be recalled.
            </p>
            <ErrorNotice error={send.error} />
            <div className="row">
              <button className="btn btn--primary" autoFocus disabled={send.busy} onClick={() => void sendAll()}>
                {send.busy ? "Sending…" : `Send to ${count}`}
              </button>
              <button className="btn btn--ghost" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- sent
function Sent() {
  const { data, error, loading, reload } = useLoad(() => api.newsletters());
  const [open, setOpen] = useState<Newsletter | null>(null);
  const sending = (data ?? []).some((n) => n.status === "sending");
  useEffect(() => {
    if (!sending) return;
    const id = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(id);
  }, [sending, reload]);

  return (
    <>
      <div className="panel-head">
        <div>
          <h2>Sent</h2>
          <p className="muted">Every send, who it went to and what happened{sending ? " - updating while a send runs." : "."}</p>
        </div>
        <div className="row"><button className="btn btn--ghost" onClick={() => reload()}>Refresh</button></div>
      </div>
      <ErrorNotice error={error} />
      {loading && !data ? <Printing /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Sent</th><th>Subject</th><th>Status</th><th>Recipients</th><th>Delivered</th><th>By</th></tr></thead>
            <tbody>
              {(data ?? []).length === 0 && <tr><td colSpan={6} className="empty">No news sent yet. Write one under Compose.</td></tr>}
              {(data ?? []).map((n) => (
                <tr key={n.newsletterId} className="clickable" onClick={() => setOpen(n)}>
                  <td className="small nowrap">{fmtDate(n.createdAt)}</td>
                  <td className="strong">{n.subject}</td>
                  <td><Status value={n.status} /></td>
                  <td className="mono">{n.recipientCount}</td>
                  <td className="mono">{n.sentCount} sent{n.failedCount ? ` · ${n.failedCount} failed` : ""}</td>
                  <td className="small">{n.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <NewsletterModal id={open.newsletterId} onClose={() => setOpen(null)} />}
    </>
  );
}

function NewsletterModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, loading } = useLoad(() => api.newsletter(id), [id]);
  const n = data?.newsletter;
  return (
    <Modal title={n?.subject ?? "Newsletter"} onClose={onClose}>
      <ErrorNotice error={error} />
      {loading || !data ? <Printing inline /> : (
        <div className="stack">
          <dl className="mail-meta">
            <dt>Status</dt><dd><Status value={n!.status} /></dd>
            <dt>Sent</dt><dd>{fmtDate(n!.createdAt)} by {n!.createdBy}</dd>
            <dt>Result</dt><dd>{n!.sentCount} of {n!.recipientCount} delivered{n!.failedCount ? `, ${n!.failedCount} failed` : ""}</dd>
            {n!.lastError && <><dt>Last error</dt><dd className="error-text">{n!.lastError}</dd></>}
          </dl>
          <pre className="newsletter-body">{n!.body}</pre>
          <RecipientList recipients={data.recipients} />
        </div>
      )}
    </Modal>
  );
}

function RecipientList({ recipients }: { recipients: NewsletterRecipient[] }) {
  return (
    <table className="table">
      <thead><tr><th>Owner</th><th>Restaurant</th><th>Status</th></tr></thead>
      <tbody>
        {recipients.map((r) => (
          <tr key={r.email}>
            <td className="small">{r.email}</td>
            <td className="small">{r.tenantName}</td>
            <td className="small">{r.status === "failed" ? <span className="error-text">Failed{r.error ? `: ${r.error}` : ""}</span> : r.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ----------------------------------------------------------------- template
const LOGO_MAX_WIDTH = 480;

/** The picked image, shrunk to at most 480 px wide, as a PNG data URI
 * (keeps transparency; the API refuses files over 200 kB). */
function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, LOGO_MAX_WIDTH / img.naturalWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image the browser can read.")); };
    img.src = url;
  });
}

function TemplateEditor() {
  const { data, error, loading, setData } = useLoad(() => api.mailTemplate());
  if (error) return <ErrorNotice error={error} />;
  if (loading || !data) return <Printing />;
  return <TemplateForm template={data} onSaved={setData} />;
}

function TemplateForm({ template, onSaved }: { template: MailTemplate; onSaved: (t: MailTemplate) => void }) {
  const [f, setF] = useState<MailTemplateInput>({
    senderName: template.senderName, replyTo: template.replyTo, accentColor: template.accentColor,
    signature: template.signature, footer: template.footer, logo: { kind: template.logo.kind },
  });
  // What the picker shows: the saved custom logo, or the file just picked.
  const [customPreview, setCustomPreview] = useState<string | null>(template.logo.kind === "custom" ? template.logo.dataUrl : null);
  const [customName, setCustomName] = useState<string | null>(template.logo.name ?? null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const a = useAction();
  const set = <K extends keyof MailTemplateInput>(key: K) => (value: MailTemplateInput[K]) => setF((s) => ({ ...s, [key]: value }));

  const previewTemplate = useMemo(() => ({ ...f, logo: f.logo.kind === "custom" && !("dataUrl" in f.logo && f.logo.dataUrl) ? (customPreview ? { kind: "custom" as const } : { kind: "booqy" as const }) : f.logo }), [f, customPreview]);
  const preview = useDebounced(
    () => api.mailPreview({ subject: SAMPLE_SUBJECT, body: SAMPLE_BODY, template: previewTemplate }),
    [previewTemplate],
  );

  const pickFile = useCallback(async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    try {
      const dataUrl = await shrinkImage(file);
      if (dataUrl.length > 300_000) throw new Error("The logo is still over 200 kB after shrinking. Pick a simpler image.");
      setCustomPreview(dataUrl);
      setCustomName(file.name);
      setF((s) => ({ ...s, logo: { kind: "custom", dataUrl, name: file.name } }));
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (f.logo.kind === "custom" && !customPreview) {
      setFileError("Pick a logo file, or choose the Booqy logo.");
      return;
    }
    const res = await a.run(() => api.saveMailTemplate(f));
    if (res) {
      onSaved(res);
      setF((s) => ({ ...s, logo: { kind: res.logo.kind } }));
      setSaved(true);
    }
  }

  return (
    <div className="mail-grid">
      <form onSubmit={save} noValidate>
        <Card title="Brand template">
          <p className="muted small" style={{ margin: "0 0 14px" }}>
            Every message is dressed the same way: the logo at the top, your sender name, the accent colour, a signature and a footer line.
            Replies always go to the reply-to address, never to {template.from}.
          </p>
          <ErrorNotice error={a.error} />
          {saved && <Notice kind="ok">Template saved. New messages use it from now on.</Notice>}
          <div className="grid">
            <Field label="Sender name" required hint={`Shown as "${f.senderName || "Booqy"} <${template.from}>"`} error={a.fields.senderName}>
              <input className="input" value={f.senderName} maxLength={60} onChange={(e) => set("senderName")(e.target.value)} />
            </Field>
            <Field label="Reply-to address" required hint="Where an owner's reply or question lands" error={a.fields.replyTo}>
              <input className="input" type="email" value={f.replyTo} onChange={(e) => set("replyTo")(e.target.value)} />
            </Field>
            <Field label="Accent colour" hint="The short rule under the subject and the links" error={a.fields.accentColor}>
              <div className="colour-field">
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(f.accentColor) ? f.accentColor : "#350001"} onChange={(e) => set("accentColor")(e.target.value)} aria-label="Pick accent colour" />
                <input className="input mono" value={f.accentColor} maxLength={7} onChange={(e) => set("accentColor")(e.target.value)} />
              </div>
            </Field>
          </div>
          <Field label="Logo" error={a.fields.logo ?? a.fields["logo.kind"] ?? fileError ?? undefined}>
            <LogoPicker kind={f.logo.kind} customPreview={customPreview} customName={customName}
                        onKind={(kind) => setF((s) => ({ ...s, logo: kind === "booqy" ? { kind } : { kind, ...(customPreview && "dataUrl" in s.logo ? { dataUrl: s.logo.dataUrl, name: s.logo.name } : {}) } }))}
                        onFile={(file) => void pickFile(file)} />
          </Field>
          <div className="grid">
            <Field label="Signature" wide hint="Closes every message, above the footer" error={a.fields.signature}>
              <textarea className="input" rows={3} value={f.signature} maxLength={600} onChange={(e) => set("signature")(e.target.value)} />
            </Field>
            <Field label="Footer line" wide hint="Small print at the bottom; the reply-to address is always added after it" error={a.fields.footer}>
              <textarea className="input" rows={2} value={f.footer} maxLength={600} onChange={(e) => set("footer")(e.target.value)} />
            </Field>
          </div>
          <div className="mail-actions">
            <button className="btn btn--primary" disabled={a.busy}>{a.busy ? "Saving…" : "Save template"}</button>
            {template.updatedAt && <span className="muted">Last saved {fmtDate(template.updatedAt)} by {template.updatedBy}</span>}
          </div>
        </Card>
      </form>
      <Preview html={preview.value?.html ?? null} title="Preview with sample text" />
    </div>
  );
}

function LogoPicker(props: {
  kind: "booqy" | "custom";
  customPreview: string | null;
  customName: string | null;
  onKind: (kind: "booqy" | "custom") => void;
  onFile: (file: File | undefined) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const option = (kind: "booqy" | "custom", label: string, box: ReactNode) => (
    <label className={`logo-option${props.kind === kind ? " logo-option--on" : ""}`}>
      <input type="radio" name="logo" checked={props.kind === kind} onChange={() => props.onKind(kind)} />
      <span className="logo-option__label">{label}</span>
      {box}
    </label>
  );
  return (
    <div className="logo-pick">
      <div className="logo-pick__options">
        {option("booqy", "Booqy logo (built in)", <span className="logo-box"><BooqyLogoMark /></span>)}
        {option("custom", "Your own logo", props.customPreview
          ? <span className="logo-box"><img src={props.customPreview} alt={props.customName ?? "Uploaded logo"} /></span>
          : <span className="logo-box logo-box--empty">No file yet</span>)}
      </div>
      {props.kind === "custom" && (
        <label className="logo-file">
          PNG or JPEG, ideally wider than tall; it's shrunk to 480 px wide and sent inline in every message.
          <input ref={fileRef} type="file" accept="image/png,image/jpeg" onChange={(e) => props.onFile(e.target.files?.[0])} />
          {props.customName && <span className="muted"> Picked: {props.customName}</span>}
        </label>
      )}
    </div>
  );
}

/** The same wordmark the email carries, in print black for the picker. */
function BooqyLogoMark() {
  return (
    <svg viewBox="52 191 416 180" width={100} aria-hidden="true" focusable="false" style={{ color: "#1c1918" }}>
      <g fill="none" stroke="currentColor" strokeWidth={14} strokeLinecap="round">
        <circle cx={104.5} cy={281.5} r={35.5} /><circle cx={186} cy={281.5} r={35.5} />
        <circle cx={265.5} cy={281.5} r={35.5} /><circle cx={345} cy={281.5} r={35.5} />
        <path d="M66.5 205.5V311.5" /><path d="M379 281.5V351" /><path d="M387 240 424 315" /><path d="M453 238 405 356" />
      </g>
      <g fill="currentColor"><path d="M84 280.5A20.5 20.5 0 0 1 125 280.5Z" /><rect x={79.5} y={282.5} width={50} height={5} /></g>
    </svg>
  );
}
