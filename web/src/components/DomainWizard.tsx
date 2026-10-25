import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, uploadToS3 } from "../api";
import type { DnsRecord, DnsScan, DomainOffer, Money, RegistrantContact, SupportCase, Tenant, TransferCheck } from "../types";
import { ErrorNotice, Field, Modal, Notice, useAction } from "./ui";
import { POSTAL_CODE_INPUT, formatPostalCode, postalCodeDigits } from "../postalCode";
import { PhoneInput } from "./PhoneInput";

type Path = "choose" | "buy" | "connect" | "cname";

export function money(m?: Money | null) {
  if (!m) return "-";
  return new Intl.NumberFormat("sv-SE", { style: "currency", currency: m.currency }).format(Number(m.amount));
}

/** Add domain: buy a new one, connect one they have (we take over DNS), or a bare CNAME. */
export default function DomainWizard({ tenant, onClose, onChanged }: {
  tenant: Tenant; onClose: () => void; onChanged: () => void;
}) {
  const [path, setPath] = useState<Path>("choose");
  return (
    <Modal title="Add domain" onClose={onClose}>
      {path === "choose" && (
        <div className="choices">
          <button className="choice" onClick={() => setPath("buy")}>
            <strong>Buy a new domain</strong>
            <span className="small muted">Search .se / .com / .eu, see the price, register it in the restaurant's name. .se needs the registreringsbevis.</span>
          </button>
          <button className="choice" onClick={() => setPath("connect")}>
            <strong>Connect a domain they already have</strong>
            <span className="small muted">It stays at one.com (or wherever). We copy its DNS records to Route 53, they switch the name servers. The bare domain works too.</span>
          </button>
          <button className="choice" onClick={() => setPath("cname")}>
            <strong>Just a CNAME</strong>
            <span className="small muted">Advanced: they keep their DNS and add one record for www. The bare domain can't be used.</span>
          </button>
        </div>
      )}
      {path === "buy" && <Buy tenant={tenant} onBack={() => setPath("choose")} onDone={onChanged} />}
      {path === "connect" && <Connect tenant={tenant} onBack={() => setPath("choose")} onDone={onChanged} />}
      {path === "cname" && <Cname tenant={tenant} onBack={() => setPath("choose")} onDone={onChanged} />}
    </Modal>
  );
}

function Back({ onClick }: { onClick: () => void }) {
  return <button type="button" className="link back" onClick={onClick}>← Other ways</button>;
}

// ------------------------------------------------------------------- buy
function contactFrom(t: Tenant): RegistrantContact {
  const [first, ...rest] = (t.ownerName ?? "").trim().split(/\s+/);
  return {
    legalName: t.legalName ?? "", orgNumber: t.orgNumber ?? "",
    firstName: first ?? "", lastName: rest.join(" "),
    email: t.contactEmail ?? t.ownerEmail ?? "", phone: t.contactPhone ?? t.ownerPhone ?? "",
    address: { street: t.address?.street ?? "", postalCode: formatPostalCode(t.address?.postalCode ?? ""), city: t.address?.city ?? "" },
  };
}

/** The contact as the API gets it: postal code as 5 digits, no space. */
function contactForApi(c: RegistrantContact): RegistrantContact {
  return { ...c, address: { ...c.address, postalCode: postalCodeDigits(c.address.postalCode) } };
}

function Buy({ tenant, onBack, onDone }: { tenant: Tenant; onBack: () => void; onDone: () => void }) {
  const [q, setQ] = useState(tenant.slug);
  const [offers, setOffers] = useState<{ results: DomainOffer[]; suggestions: DomainOffer[] } | null>(null);
  const [pick, setPick] = useState<DomainOffer | null>(null);
  const search = useAction();

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    setPick(null);
    const r = await search.run(() => api.searchDomains(q));
    if (r) setOffers(r);
  }

  if (pick) return <Order tenant={tenant} offer={pick} onBack={() => setPick(null)} onDone={onDone} />;
  return (
    <>
      <Back onClick={onBack} />
      <form className="inline-form" onSubmit={onSearch} noValidate>
        <Field label="Name" error={search.fields.q} hint="e.g. arya or arya.se">
          <input className="input mono" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </Field>
        <button className="btn btn--primary" disabled={!q.trim() || search.busy}>{search.busy ? "Searching…" : "Search"}</button>
      </form>
      <ErrorNotice error={search.error} />
      {offers && (
        <table className="table offers">
          <thead><tr><th>Domain</th><th>First year</th><th>Then / year</th><th /></tr></thead>
          <tbody>
            {[...offers.results, ...offers.suggestions].map((o) => (
              <tr key={o.domain}>
                <td className="strong mono">{o.domain}
                  {o.verificationRequired && o.available && <div className="small muted">Needs registreringsbevis</div>}</td>
                <td>{o.available ? money(o.price) : "-"}</td>
                <td>{o.available ? money(o.renewalPrice) : "-"}</td>
                <td className="right">
                  {o.available && o.sellable
                    ? <button className="btn btn--small" onClick={() => setPick(o)} disabled={!o.price}>Choose</button>
                    : <span className="small muted">{o.sellable ? "Taken" : "Not sold here"}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Order({ tenant, offer, onBack, onDone }: {
  tenant: Tenant; offer: DomainOffer; onBack: () => void; onDone: () => void;
}) {
  const [c, setC] = useState<RegistrantContact>(() => contactFrom(tenant));
  const [documentKey, setDocumentKey] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [primary, setPrimary] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<SupportCase | null | undefined>(undefined);
  const buy = useAction();
  const se = offer.verificationRequired;

  async function onBuy(e: FormEvent) {
    e.preventDefault();
    if (!offer.price) return;
    const r = await buy.run(() => api.registerDomain(tenant.tenantId, {
      domain: offer.domain, makePrimary: primary, contact: contactForApi(c), acceptedPrice: offer.price!,
      ...(se ? { documentKey } : {}),
    }));
    if (r) { setResult(r.supportCase); onDone(); }
  }

  if (result !== undefined) {
    return (
      <>
        <Notice kind="ok"><strong>{offer.domain}</strong> is ordered. Its status is on the Domains tab.</Notice>
        {result ? <SupportCaseBox domain={offer.domain} tenantId={tenant.tenantId} supportCase={result} />
          : <p className="small muted">Route 53 registers it within minutes to an hour; the site goes live on {offer.domain} and www.{offer.domain} by itself.</p>}
      </>
    );
  }
  return (
    <form onSubmit={onBuy} noValidate>
      <button type="button" className="link back" onClick={onBack}>← Search again</button>
      <h4 className="mono">{offer.domain}</h4>
      <p className="small">{money(offer.price)} the first year, then {money(offer.renewalPrice)} per year (auto-renews, billed to the platform's AWS account).</p>
      <ErrorNotice error={buy.error} />
      {buy.error instanceof ApiError && buy.error.code === "price_changed" && (
        <Notice kind="warn">Search again to see the new price.</Notice>
      )}

      <RegistrantFields value={c} onChange={setC} fields={buy.fields} />
      {se && <RegistreringsbevisUpload tenantId={tenant.tenantId} error={buy.fields.documentKey}
                                       onKey={setDocumentKey} onBusy={setUploading} />}

      <label className="check"><input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> Use for links in emails (primary)</label>
      <label className="check confirm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I'm buying {offer.domain} for {money(offer.price)} (renews at {money(offer.renewalPrice)}/year). It can't be refunded.</label>
      <div className="row">
        <button className="btn btn--primary" disabled={!confirmed || buy.busy || uploading || (se && !documentKey)}>
          {buy.busy ? "Buying…" : `Buy ${offer.domain}`}
        </button>
      </div>
    </form>
  );
}

export function SupportCaseBox({ domain, tenantId, supportCase }: { domain: string; tenantId: string; supportCase: SupportCase }) {
  const dl = useAction();
  return (
    <Notice kind="warn">
      <strong>One manual step:</strong> open an AWS Support case so the .se registry can verify the owner. The domain stays
      “Waiting for .se verification” until it's approved; then everything continues by itself.
      <ol className="small steps">
        <li>AWS console of this environment's account → Support Center → Create case → <em>Account and billing</em> →
          service <strong>{supportCase.service}</strong>, category <strong>{supportCase.category}</strong>.</li>
        <li>Subject and text:
          <div className="copy"><input className="input mono" readOnly value={supportCase.subject} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn btn--small" onClick={() => navigator.clipboard.writeText(supportCase.subject)}>Copy</button></div>
          <textarea className="input mono" rows={7} readOnly value={supportCase.body} />
          <button type="button" className="btn btn--small" onClick={() => navigator.clipboard.writeText(supportCase.body)}>Copy text</button>
        </li>
        <li>Attach the registreringsbevis:{" "}
          <button type="button" className="btn btn--small" disabled={dl.busy}
                  onClick={async () => { const r = await dl.run(() => api.domainDocument(tenantId, domain)); if (r) window.open(r.url, "_blank", "noopener"); }}>
            Download PDF
          </button>
        </li>
      </ol>
      <ErrorNotice error={dl.error} />
    </Notice>
  );
}

// --------------------------------------------------- shared form pieces
export function RegistrantFields({ value: c, onChange, fields }: {
  value: RegistrantContact; onChange: (c: RegistrantContact) => void; fields: Record<string, string>;
}) {
  const err = (k: string) => fields[`contact.${k}`];
  const set = (k: keyof RegistrantContact) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...c, [k]: e.target.value });
  const setAddr = (k: keyof RegistrantContact["address"]) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...c, address: { ...c.address, [k]: k === "postalCode" ? formatPostalCode(e.target.value) : e.target.value } });
  return (
    <>
      <h5>Registrant - the restaurant's AB (owns the domain)</h5>
      <div className="grid">
        <Field label="Company (legal name)" required error={err("legalName")}><input className="input" value={c.legalName} onChange={set("legalName")} /></Field>
        <Field label="Org. number" required error={err("orgNumber")} hint="NNNNNN-NNNN"><input className="input mono" value={c.orgNumber} onChange={set("orgNumber")} /></Field>
        <Field label="Contact first name" required error={err("firstName")}><input className="input" value={c.firstName} onChange={set("firstName")} /></Field>
        <Field label="Contact last name" required error={err("lastName")}><input className="input" value={c.lastName} onChange={set("lastName")} /></Field>
        <Field label="Email" required error={err("email")} hint="Registry notices go here"><input className="input" value={c.email} onChange={set("email")} /></Field>
        <Field label="Phone" required error={err("phone")}><PhoneInput className="input" value={c.phone} onChange={(v) => onChange({ ...c, phone: v })} /></Field>
        <Field label="Street" required error={err("address.street")}><input className="input" value={c.address.street} onChange={setAddr("street")} /></Field>
        <Field label="Postal code" required error={err("address.postalCode")}><input className="input mono" {...POSTAL_CODE_INPUT} value={c.address.postalCode} onChange={setAddr("postalCode")} /></Field>
        <Field label="City" required error={err("address.city")}><input className="input" value={c.address.city} onChange={setAddr("city")} /></Field>
      </div>
    </>
  );
}

/** Required step for .se: uploads the PDF straight to the private bucket. */
export function RegistreringsbevisUpload({ tenantId, error, onKey, onBusy }: {
  tenantId: string; error?: string; onKey: (key: string) => void; onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState("");
  const upload = useAction();
  async function onFile(f: File | null) {
    setName("");
    onKey("");
    if (!f) return;
    onBusy(true);
    const key = await upload.run(async () => {
      if (f.type !== "application/pdf") throw new Error("The registreringsbevis must be a PDF");
      const up = await api.documentUpload(tenantId);
      if (f.size > up.maxBytes) throw new Error("At most 10 MB");
      await uploadToS3(up.upload, f);
      return up.documentKey;
    });
    onBusy(false);
    if (key) { onKey(key); setName(f.name); }
  }
  return (
    <>
      <h5>Registreringsbevis (required for .se)</h5>
      <p className="small muted">The company's registration certificate from Bolagsverket, as a PDF (max 10 MB). The .se registry verifies the owner before it takes effect. Stored encrypted and deleted once verified (after 30 days at the latest).</p>
      <Field label="PDF" error={error}>
        <input className="input" type="file" accept="application/pdf" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
      </Field>
      {upload.busy && <p className="small muted">Uploading…</p>}
      <ErrorNotice error={upload.error} />
      {name && <Notice kind="ok">Uploaded: {name}</Notice>}
    </>
  );
}

// -------------------------------------------------------------- transfer
/** Move a connected (live) domain's registration from one.com etc. into Route 53. */
export function TransferModal({ tenant, domain, onClose, onDone }: {
  tenant: Tenant; domain: string; onClose: () => void; onDone: () => void;
}) {
  const check = useLoadCheck(tenant.tenantId, domain);
  const [c, setC] = useState<RegistrantContact>(() => contactFrom(tenant));
  const [authCode, setAuthCode] = useState("");
  const [documentKey, setDocumentKey] = useState("");
  const [uploading, setUploading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<SupportCase | null | undefined>(undefined);
  const go = useAction();
  const info = check.data;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!info?.price) return;
    const r = await go.run(() => api.transferDomain(tenant.tenantId, domain, {
      authCode, contact: contactForApi(c), acceptedPrice: info.price!, ...(info.verificationRequired ? { documentKey } : {}),
    }));
    if (r) { setResult(r.supportCase); onDone(); }
  }

  return (
    <Modal title={`Transfer ${domain} to Route 53`} onClose={onClose}>
      {result !== undefined ? (
        <>
          <Notice kind="ok">Transfer started. The site and email keep working - the name servers don't change.
            The old registrar usually releases the domain within 5-7 days (approving their email speeds it up).</Notice>
          {result && <SupportCaseBox domain={domain} tenantId={tenant.tenantId} supportCase={result} />}
        </>
      ) : (
        <>
          <p className="small">Moves the <em>registration</em> from the current registrar into our Route 53 account: one bill,
            renewals handled by us. DNS is already ours, so nothing goes offline. A failed transfer just leaves it where it is.</p>
          {check.busy && <p className="muted small">Checking with the registry…</p>}
          <ErrorNotice error={check.error} />
          {info && !info.transferable && <Notice kind="warn">Can't transfer right now: {info.reason}</Notice>}
          {info?.transferable && (
            <form onSubmit={onSubmit} noValidate>
              <p className="small"><strong>{money(info.price)}</strong> - includes one more year; then {money(info.renewalPrice)}/year (auto-renews).</p>
              <ErrorNotice error={go.error} />
              {go.error instanceof ApiError && go.error.code === "price_changed" && <Notice kind="warn">Close and reopen to see the new price.</Notice>}
              <Field label="Authorization code" required error={go.fields.authCode}
                     hint="From the current registrar (one.com: Domain → Transfer / EPP code). Ask them to unlock the domain too.">
                <input className="input mono" value={authCode} onChange={(e) => setAuthCode(e.target.value)} autoComplete="off" />
              </Field>
              <RegistrantFields value={c} onChange={setC} fields={go.fields} />
              {info.verificationRequired && <RegistreringsbevisUpload tenantId={tenant.tenantId} error={go.fields.documentKey}
                                                                     onKey={setDocumentKey} onBusy={setUploading} />}
              <label className="check confirm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                Transfer {domain} for {money(info.price)}. It can't be refunded.</label>
              <div className="row">
                <button className="btn btn--primary"
                        disabled={!confirmed || !authCode.trim() || go.busy || uploading || (info.verificationRequired && !documentKey)}>
                  {go.busy ? "Starting…" : "Start transfer"}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </Modal>
  );
}

function useLoadCheck(tenantId: string, domain: string) {
  const a = useAction();
  const [data, setData] = useState<TransferCheck | null>(null);
  useEffect(() => {
    void a.run(() => api.transferCheck(tenantId, domain)).then((r) => r && setData(r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, domain]);
  return { data, busy: a.busy, error: a.error };
}

// --------------------------------------------------------------- connect
type Row = DnsRecord & { include: boolean; id: number; valuesText: string };
const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "SRV"];
let nextId = 1;

function Connect({ tenant, onBack, onDone }: { tenant: Tenant; onBack: () => void; onDone: () => void }) {
  const [domain, setDomain] = useState("");
  const [scan, setScan] = useState<DnsScan | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [primary, setPrimary] = useState(true);
  const [checked, setChecked] = useState(false);
  const [done, setDone] = useState<{ nameServers: string[]; domain: string } | null>(null);
  const scanA = useAction();
  const connect = useAction();

  async function onScan(e: FormEvent) {
    e.preventDefault();
    const r = await scanA.run(() => api.scanDns(domain));
    if (!r) return;
    setScan(r);
    setDomain(r.domain);
    setChecked(false);
    setRows(r.records.map((x) => ({ ...x, include: !x.skip, id: nextId++, valuesText: x.values.join("\n") })));
  }
  const update = (id: number, patch: Partial<Row>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function onConnect() {
    if (!scan) return;
    const records = rows.filter((r) => r.include && !r.skip).map((r) => ({
      name: r.name, type: r.type, ttl: Number(r.ttl) || 3600,
      values: r.valuesText.split("\n").map((v) => v.trim()).filter(Boolean),
    }));
    const res = await connect.run(() => api.connectDomain(tenant.tenantId, { domain: scan.domain, makePrimary: primary, records }));
    if (res) { setDone({ nameServers: res.nameServers, domain: scan.domain }); onDone(); }
  }

  if (done) {
    return (
      <>
        <Notice kind="ok">The DNS zone for <strong>{done.domain}</strong> is ready with the copied records.</Notice>
        <NameServerBox domain={done.domain} nameServers={done.nameServers} />
      </>
    );
  }
  return (
    <>
      <Back onClick={onBack} />
      <form className="inline-form" onSubmit={onScan} noValidate>
        <Field label="Their domain" error={scanA.fields.domain} hint="The domain itself, e.g. restaurang.se">
          <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="restaurang.se" autoFocus />
        </Field>
        <button className="btn btn--primary" disabled={!domain.trim() || scanA.busy}>{scanA.busy ? "Scanning…" : "Scan DNS"}</button>
      </form>
      <ErrorNotice error={scanA.error} />
      {scan && (
        <>
          {!scan.registered && <Notice kind="warn">{scan.domain} has no name servers - is it registered? Check the spelling.</Notice>}
          {scan.nameServers.length > 0 && <p className="small">DNS is at: <span className="mono">{scan.nameServers.join(", ")}</span></p>}
          {scan.dnssec && <Notice kind="warn">DNSSEC is on. The restaurant must turn it off at their registrar <strong>before</strong> switching name servers, or the domain stops resolving.</Notice>}
          <p className="small">These are the records we found. Everything ticked is copied to Route 53. Go through it with the restaurant -
            a record left out stops working when the name servers change (email is the usual casualty: MX, SPF, DKIM).
            Add anything we couldn't find (other DKIM selectors, own subdomains).</p>
          <div className="table-wrap">
            <table className="table records">
              <thead><tr><th /><th>Name</th><th>Type</th><th>TTL</th><th>Value(s), one per line</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.skip ? "muted" : undefined}>
                    <td><input type="checkbox" checked={r.include && !r.skip} disabled={!!r.skip}
                               onChange={(e) => update(r.id, { include: e.target.checked })} aria-label={`Copy ${r.name} ${r.type}`} /></td>
                    <td><input className="input mono" value={r.name} disabled={!!r.skip} onChange={(e) => update(r.id, { name: e.target.value })} /></td>
                    <td><select className="input" value={r.type} disabled={!!r.skip} onChange={(e) => update(r.id, { type: e.target.value })}>
                      {(TYPES.includes(r.type) ? TYPES : [r.type, ...TYPES]).map((t) => <option key={t}>{t}</option>)}</select></td>
                    <td><input className="input mono ttl" value={r.ttl} disabled={!!r.skip} onChange={(e) => update(r.id, { ttl: Number(e.target.value) || 0 })} /></td>
                    <td>{r.skip ? <span className="small">{r.skip}</span>
                      : <textarea className="input mono" rows={Math.min(4, Math.max(1, r.valuesText.split("\n").length))}
                                  value={r.valuesText} onChange={(e) => update(r.id, { valuesText: e.target.value })} />}</td>
                    <td>{!r.skip && <button type="button" className="btn btn--ghost btn--small" onClick={() => setRows(rows.filter((x) => x.id !== r.id))}>✕</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button type="button" className="btn btn--small" onClick={() => setRows([...rows, {
              name: scan.domain, type: "TXT", ttl: 3600, values: [], valuesText: "", include: true, id: nextId++,
            }])}>+ Add record</button>
          </div>
          <ErrorNotice error={connect.error} />
          {Object.entries(connect.fields).map(([k, msg]) => <p key={k} className="small error-text">{k}: {msg}</p>)}
          <label className="check"><input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> Use for links in emails (primary)</label>
          <label className="check confirm"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            I've checked the records with the restaurant (especially email).</label>
          <div className="row">
            <button className="btn btn--primary" disabled={!checked || connect.busy || !scan.registered} onClick={() => void onConnect()}>
              {connect.busy ? "Connecting…" : `Connect ${scan.domain}`}
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function NameServerBox({ domain, nameServers }: { domain: string; nameServers: string[] }) {
  const text = nameServers.join("\n");
  return (
    <Notice kind="info">
      Send the restaurant this: at their registrar (one.com: <em>Domain → DNS settings → Name servers → use custom</em>),
      replace the name servers of <strong>{domain}</strong> with these four:
      <pre className="code">{text}</pre>
      <button type="button" className="btn btn--small" onClick={() => navigator.clipboard.writeText(text)}>Copy</button>
      <p className="small">We check every 10 minutes (it can take a few hours to be seen). Then the certificates are issued and the site goes live on {domain} and www.{domain} by itself.</p>
    </Notice>
  );
}

// ----------------------------------------------------------------- cname
function Cname({ tenant, onBack, onDone }: { tenant: Tenant; onBack: () => void; onDone: () => void }) {
  const [domain, setDomain] = useState("");
  const [makePrimary, setPrimary] = useState(true);
  const [dns, setDns] = useState<{ name: string; value: string } | null>(null);
  const add = useAction();
  return (
    <>
      <Back onClick={onBack} />
      <form noValidate onSubmit={async (e) => {
        e.preventDefault();
        const r = await add.run(() => api.addDomain(tenant.tenantId, domain, makePrimary));
        if (r) { setDns(r.dns[0]); setDomain(""); onDone(); }
      }}>
        <ErrorNotice error={add.error} />
        <Field label="Hostname" error={add.fields.domain} hint="e.g. www.restaurang.se - the bare domain can't be a CNAME">
          <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.restaurang.se" />
        </Field>
        <label className="check"><input type="checkbox" checked={makePrimary} onChange={(e) => setPrimary(e.target.checked)} /> Use for links in emails (primary)</label>
        <button className="btn btn--primary" disabled={!domain || add.busy}>Add</button>
      </form>
      {dns && (
        <Notice kind="ok">
          Send the restaurant this DNS record to add at their DNS host:
          <pre className="code">{`${dns.name}  CNAME  ${dns.value}`}</pre>
          The certificate is issued automatically once it's in place.
        </Notice>
      )}
    </>
  );
}
