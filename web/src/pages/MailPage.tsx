import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  Card, ErrorNotice, Field, Modal, Notice, Status, errorMessage, fmtDate, useAction, useLoad,
} from "../components/ui";
import type { MailTemplate, MailTemplateInput, Newsletter, NewsletterRecipient } from "../types";
import OutboxPage from "./OutboxPage";
import { RefreshButton, SaveButton, confirmLeave, useDirty } from "../components/save";
import { SkelBlock, SkelCard, SkelLines, SkelPage, SkelTable } from "../components/Skeleton";
import { rowAction } from "../components/rowLink";

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
        {html ? <iframe className="mail-preview__frame" title="Email preview" sandbox="" srcDoc={html} /> : <SkelLines n={8} />}
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
          <button key={name} className={`tab${tab === name ? " tab--on" : ""}`} onClick={() => { if (name === tab || confirmLeave()) setTab(name); }}>{name}</button>
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
  // A draft is unsaved work: leaving asks first, sending clears it.
  useDirty({ subject, body }, { subject: "", body: "" }, { guard: !send.done });

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
            <dd>{recipients.data ? `${count} restaurant owner${count === 1 ? "" : "s"} (every active customer)` : <SkelBlock w={220} h={14} />}</dd>
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
          <SaveButton kind="ghost" type="button" label="Send me a test" busy={test.busy} busyLabel="Sending test…" done={test.done} doneLabel="Test sent"
                      disabled={!ready} onClick={() => void sendTest()} />
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
        <div className="row"><RefreshButton reload={reload} /></div>
      </div>
      <ErrorNotice error={error} />
      {loading && !data ? <SkelPage label="Loading sent mail"><SkelTable rows={5} cols={4} /></SkelPage> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Sent</th><th>Subject</th><th>Status</th><th>Recipients</th><th>Delivered</th><th>By</th></tr></thead>
            <tbody>
              {(data ?? []).length === 0 && <tr><td colSpan={6} className="empty">No news sent yet. Write one under Compose.</td></tr>}
              {(data ?? []).map((n) => (
                <tr key={n.newsletterId} className="row-link" {...rowAction(() => setOpen(n))}>
                  <td className="small nowrap">{fmtDate(n.createdAt)}</td>
                  <td className="strong row-link__name">{n.subject}</td>
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
      {loading || !data ? <SkelLines n={6} /> : (
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
/** Booqy's dark brown: the built-in logo's colour until someone picks another. */
const BOOQY_INK = "#3a2418";
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The Booqy wordmark in one colour, without a background, as an SVG data URI. */
function wordmarkUrl(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="52 191 416 180" width="${LOGO_MAX_WIDTH}" height="208">`
    + `<g fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round">`
    + `<circle cx="104.5" cy="281.5" r="35.5"/><circle cx="186" cy="281.5" r="35.5"/><circle cx="265.5" cy="281.5" r="35.5"/><circle cx="345" cy="281.5" r="35.5"/>`
    + `<path d="M66.5 205.5V311.5"/><path d="M379 281.5V351"/><path d="M387 240 424 315"/><path d="M453 238 405 356"/></g>`
    + `<g fill="${color}"><path d="M84 280.5A20.5 20.5 0 0 1 125 280.5Z"/><rect x="79.5" y="282.5" width="50" height="5"/></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't an image the browser can read."));
    img.src = src;
  });
}

/** Paints every visible part of the logo in one colour. A logo without
 * transparency (a JPEG, a logo on white) loses its plain background first:
 * how far each pixel is from the corner colour becomes how solid it is. */
function recolour(data: ImageData, color: string) {
  const px = data.data;
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  const lum = (i: number) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  const w = data.width, h = data.height;
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (h * w - 1) * 4];
  const opaque = corners.every((i) => px[i + 3] > 250);
  const bg = corners.reduce((sum, i) => sum + lum(i), 0) / corners.length;
  const range = Math.max(bg, 255 - bg) || 255;
  for (let i = 0; i < px.length; i += 4) {
    if (opaque) px[i + 3] = Math.min(255, Math.round((Math.abs(lum(i) - bg) / range) * 255 * 1.15));
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
}

/** The logo as the email gets it: a PNG at most 480 px wide, keeping
 * transparency, recoloured when a colour is given (the API refuses files over 200 kB). */
async function renderLogo(src: string, color: string | null): Promise<string> {
  const img = await loadImage(src);
  const scale = Math.min(1, LOGO_MAX_WIDTH / (img.naturalWidth || LOGO_MAX_WIDTH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((img.naturalWidth || LOGO_MAX_WIDTH) * scale));
  canvas.height = Math.max(1, Math.round((img.naturalHeight || 208) * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (color) {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    recolour(data, color);
    ctx.putImageData(data, 0, 0);
  }
  const url = canvas.toDataURL("image/png");
  if (url.length > 300_000) throw new Error("The logo is still over 200 kB after shrinking. Pick a simpler image.");
  return url;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That file couldn't be read."));
    reader.readAsDataURL(file);
  });
}

function TemplateEditor() {
  const { data, error, loading, setData } = useLoad(() => api.mailTemplate());
  if (error) return <ErrorNotice error={error} />;
  if (loading || !data) return <SkelPage label="Loading the template"><SkelCard lines={8} /></SkelPage>;
  return <TemplateForm template={data} onSaved={setData} />;
}

function TemplateForm({ template, onSaved }: { template: MailTemplate; onSaved: (t: MailTemplate) => void }) {
  const [f, setF] = useState<MailTemplateInput>({
    senderName: template.senderName, replyTo: template.replyTo, accentColor: template.accentColor,
    signature: template.signature, footer: template.footer, logo: { kind: template.logo.kind },
  });
  // The uploaded logo as picked (before any recolouring), and how it looks now.
  const [customSource, setCustomSource] = useState<string | null>(template.logo.kind === "custom" ? template.logo.dataUrl : null);
  const [customPreview, setCustomPreview] = useState<string | null>(template.logo.kind === "custom" ? template.logo.dataUrl : null);
  const [customName, setCustomName] = useState<string | null>(template.logo.name ?? null);
  const [booqyColor, setBooqyColor] = useState<string>(template.logo.kind === "booqy" && template.logo.color ? template.logo.color : BOOQY_INK);
  const [customColor, setCustomColor] = useState<string | null>(template.logo.kind === "custom" ? template.logo.color ?? null : null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const a = useAction();
  const dirty = useDirty(f, {
    senderName: template.senderName, replyTo: template.replyTo, accentColor: template.accentColor,
    signature: template.signature, footer: template.footer, logo: { kind: template.logo.kind },
  });
  const set = <K extends keyof MailTemplateInput>(key: K) => (value: MailTemplateInput[K]) => setF((s) => ({ ...s, [key]: value }));

  const previewTemplate = useMemo(() => ({ ...f, logo: f.logo.kind === "custom" && !f.logo.dataUrl && !customPreview ? { kind: "booqy" as const } : f.logo }), [f, customPreview]);
  const preview = useDebounced(
    () => api.mailPreview({ subject: SAMPLE_SUBJECT, body: SAMPLE_BODY, template: previewTemplate }),
    [previewTemplate],
  );

  // Draws the chosen logo in its colour; only the latest choice lands.
  const drawn = useRef(0);
  const draw = useCallback(async (kind: "booqy" | "custom", color: string | null, source: string | null, name: string | null) => {
    const turn = ++drawn.current;
    setFileError(null);
    if (kind === "custom" && !source) {
      setF((s) => ({ ...s, logo: { kind } }));
      return;
    }
    try {
      const dataUrl = kind === "booqy" ? await renderLogo(wordmarkUrl(color ?? BOOQY_INK), null) : await renderLogo(source!, color);
      if (turn !== drawn.current) return;
      if (kind === "custom") setCustomPreview(dataUrl);
      setF((s) => ({ ...s, logo: { kind, dataUrl, color, ...(kind === "custom" && name ? { name } : {}) } }));
    } catch (e) {
      if (turn === drawn.current) setFileError(errorMessage(e));
    }
  }, []);

  const pickFile = useCallback(async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    try {
      const source = await readFile(file);
      await loadImage(source);
      setCustomSource(source);
      setCustomName(file.name);
      await draw("custom", customColor, source, file.name);
    } catch (e) {
      setFileError(errorMessage(e));
    }
  }, [customColor, draw]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (f.logo.kind === "custom" && !customPreview) {
      setFileError("Upload a logo file, or choose the Booqy logo.");
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
            <Field label="Sender name" required changed={dirty.changed("senderName")} hint={`Shown as "${f.senderName || "Booqy"} <${template.from}>"`} error={a.fields.senderName}>
              <input className="input" value={f.senderName} maxLength={60} onChange={(e) => set("senderName")(e.target.value)} />
            </Field>
            <Field label="Reply-to address" required changed={dirty.changed("replyTo")} hint="Where an owner's reply or question lands" error={a.fields.replyTo}>
              <input className="input" type="email" value={f.replyTo} onChange={(e) => set("replyTo")(e.target.value)} />
            </Field>
            <Field label="Accent colour" changed={dirty.changed("accentColor")} hint="The short rule under the subject and the links" error={a.fields.accentColor}>
              <div className="colour-field">
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(f.accentColor) ? f.accentColor : "#350001"} onChange={(e) => set("accentColor")(e.target.value)} aria-label="Pick accent colour" />
                <input className="input mono" value={f.accentColor} maxLength={7} onChange={(e) => set("accentColor")(e.target.value)} />
              </div>
            </Field>
          </div>
          <Field label="Logo" changed={dirty.changed("logo")} error={a.fields.logo ?? a.fields["logo.kind"] ?? fileError ?? undefined}>
            <LogoPicker kind={f.logo.kind} customPreview={customPreview} customName={customName}
                        booqyColor={booqyColor} customColor={customColor}
                        onKind={(kind) => void draw(kind, kind === "booqy" ? booqyColor : customColor, customSource, customName)}
                        onColor={(color) => {
                          if (f.logo.kind === "booqy") setBooqyColor(color ?? BOOQY_INK);
                          else setCustomColor(color);
                          if (color === null || HEX.test(color)) void draw(f.logo.kind, color, customSource, customName);
                        }}
                        onFile={(file) => void pickFile(file)} />
          </Field>
          <div className="grid">
            <Field label="Signature" wide changed={dirty.changed("signature")} hint="Closes every message, above the footer" error={a.fields.signature}>
              <textarea className="input" rows={3} value={f.signature} maxLength={600} onChange={(e) => set("signature")(e.target.value)} />
            </Field>
            <Field label="Footer line" wide changed={dirty.changed("footer")} hint="Small print at the bottom; the reply-to address is always added after it" error={a.fields.footer}>
              <textarea className="input" rows={2} value={f.footer} maxLength={600} onChange={(e) => set("footer")(e.target.value)} />
            </Field>
          </div>
          <div className="mail-actions">
            <SaveButton label="Save template" busy={a.busy} done={a.done} dirty={dirty.dirty} />
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
  booqyColor: string;
  customColor: string | null;
  onKind: (kind: "booqy" | "custom") => void;
  onColor: (color: string | null) => void;
  onFile: (file: File | undefined) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const option = (kind: "booqy" | "custom", label: string, box: ReactNode) => (
    <label className={`logo-option${props.kind === kind ? " logo-option--on" : ""}`}>
      <input type="radio" name="logo" checked={props.kind === kind}
             onChange={() => { props.onKind(kind); if (kind === "custom" && !props.customPreview) fileRef.current?.click(); }} />
      <span className="logo-option__label">{label}</span>
      {box}
    </label>
  );
  const booqy = props.kind === "booqy";
  const color = booqy ? props.booqyColor : props.customColor;
  return (
    <div className="logo-pick">
      <div className="logo-pick__options">
        {option("booqy", "Booqy logo (built in)", <span className="logo-box"><img src={wordmarkUrl(HEX.test(props.booqyColor) ? props.booqyColor : BOOQY_INK)} alt="" /></span>)}
        {option("custom", "Your own logo", props.customPreview
          ? <span className="logo-box"><img src={props.customPreview} alt={props.customName ?? "Uploaded logo"} /></span>
          : <span className="logo-box logo-box--empty">No file yet</span>)}
      </div>
      <div className="logo-file" hidden={booqy}>
        <button type="button" className="btn btn--ghost btn--small" onClick={() => fileRef.current?.click()}>
          {props.customPreview ? "Upload another logo" : "Upload logo"}
        </button>
        {props.customName && <span className="muted small">{props.customName}</span>}
        <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
               aria-label="Logo file" onChange={(e) => { props.onFile(e.target.files?.[0]); e.target.value = ""; }} />
        <span className="muted small logo-file__hint">Any image: PNG, JPEG, SVG, WebP or GIF. It's turned into a PNG at most 480 px wide and sent inline in every message.</span>
      </div>
      <div className="logo-colour">
        {!booqy && (
          <select className="input" value={color === null ? "original" : "one"} aria-label="Logo colours"
                  onChange={(e) => props.onColor(e.target.value === "original" ? null : BOOQY_INK)}>
            <option value="original">The file's own colours</option>
            <option value="one">One colour</option>
          </select>
        )}
        {color !== null && (
          <div className="colour-field">
            <input type="color" value={HEX.test(color) ? color : BOOQY_INK} onChange={(e) => props.onColor(e.target.value)} aria-label="Pick logo colour" />
            <input className="input mono" value={color} maxLength={7} aria-label="Logo colour" onChange={(e) => props.onColor(e.target.value)} />
          </div>
        )}
        <span className="muted small">
          {color === null
            ? "Sent as uploaded. Pick One colour to paint it in your colour."
            : booqy
              ? "The Booqy logo in this colour, with no background."
              : "Every visible part of the logo gets this colour; a white or plain background is removed."}
        </span>
      </div>
    </div>
  );
}
