import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, uploadToS3 } from "../api";
import type {
  DnsRecord, DnsScan, DomainOffer, Money, RegistrantContact, RequiredRecord, SupportCase, Tenant, TransferCheck, TransferInCheck, Zone,
} from "../types";
import { ErrorNotice, Field, Modal, Notice, Printing, useAction } from "./ui";
import { POSTAL_CODE_INPUT, formatPostalCode, postalCodeDigits } from "../postalCode";
import { PhoneInput } from "./PhoneInput";
import { Select } from "./Select";
import { isProd, testMapping } from "../testSites";
import { InfoTip } from "./StepFlow";

type Path = "choose" | "buy" | "move" | "keep" | "map";

export function money(m?: Money | null) {
  if (!m) return "-";
  return new Intl.NumberFormat("sv-SE", { style: "currency", currency: m.currency }).format(Number(m.amount));
}

/** Add domain (owner 2026-11-15): the three ways in, each ending in the same pipeline (site on the domain,
 * www and the slug address 301 to it, dev.<domain> on the dev site). Buy new: Booqy registers it. Move to
 * Booqy: the transfer code from their registrar, the owner approves by e-mail. Keep current registrar: DNS
 * records at the registrar, or the name servers pointed at us. The dev console runs the same flows for a
 * test customer, simulated (nothing is bought or moved; Simulate on the Domains tab moves them). */
export default function DomainWizard({ tenant, onClose, onChanged, initial }: {
  tenant: Tenant; onClose: () => void; onChanged: () => void; initial?: { path: Path; domain?: string };
}) {
  const [path, setPath] = useState<Path>(initial?.path ?? "choose");
  const [domain, setDomain] = useState(initial?.domain ?? "");
  const sim = !isProd();
  if (sim && tenant.siteKind !== "test") {
    return (
      <Modal title="Add domain" onClose={onClose}>
        <Notice kind="info">This customer's own domain is managed from the production console.</Notice>
        <TestMapping tenant={tenant} onDone={onChanged} />
      </Modal>
    );
  }
  const keep = (d: string) => { setDomain(d); setPath("keep"); };
  return (
    <Modal title="Add domain" onClose={onClose} wide={path === "move" || path === "keep"}>
      {sim && <p className="small muted sim-note">Simulated <InfoTip label="Simulated">Test customer: nothing is bought or moved and no DNS changes. The flow is the real one; Simulate on the Domains tab plays the registry, the owner and the restaurant. At the end the domain is mapped onto the test sites.</InfoTip></p>}
      {path === "choose" && (
        <div className="choices" role="list">
          <button className="choice" onClick={() => setPath("buy")}>
            <strong>Buy new</strong>
            <span className="small muted">Booqy registers it</span>
          </button>
          <button className="choice" onClick={() => setPath("move")}>
            <strong>Move to Booqy</strong>
            <span className="small muted">Transfer code from their registrar</span>
          </button>
          <button className="choice" onClick={() => setPath("keep")}>
            <strong>Keep current registrar</strong>
            <span className="small muted">DNS records or name servers</span>
          </button>
          {sim && <button type="button" className="link" onClick={() => setPath("map")}>Map directly onto the test sites</button>}
        </div>
      )}
      {path === "buy" && <Buy tenant={tenant} onBack={() => setPath("choose")} onDone={onChanged} />}
      {path === "move" && <MoveToBooqy tenant={tenant} initialDomain={domain} onBack={() => setPath("choose")} onKeep={keep} onDone={onChanged} />}
      {path === "keep" && <KeepRegistrar tenant={tenant} initialDomain={domain} onBack={() => setPath("choose")} onDone={onChanged} />}
      {path === "map" && <><Back onClick={() => setPath("choose")} /><TestMapping tenant={tenant} onDone={onChanged} /></>}
    </Modal>
  );
}

function Back({ onClick }: { onClick: () => void }) {
  return <button type="button" className="link back" onClick={onClick}>← Other ways</button>;
}

/** What the restaurant reads, in Swedish (it also gets it by e-mail): shown for copying. */
export function RestaurantText({ text, title = "Restaurant's steps (Swedish)" }: { text: string; title?: string }) {
  return (
    <div className="restaurant-text">
      <div className="row restaurant-text__head">
        <span className="small strong">{title}</span>
        <button type="button" className="btn btn--small" onClick={() => void navigator.clipboard.writeText(text)}>Copy</button>
      </div>
      <pre className="restaurant-text__body" lang="sv">{text}</pre>
    </div>
  );
}

/** DNS records mode: what the restaurant adds at its registrar. */
export function RecordsTable({ records }: { records: RequiredRecord[] }) {
  return (
    <div className="table-wrap">
      <table className="table required-records">
        <thead><tr><th>Type</th><th>Name</th><th>Value</th><th /></tr></thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.host + r.type}>
              <td data-label="Type" className="mono">{r.type}</td>
              <td data-label="Name" className="mono cell-title">{r.name}</td>
              <td data-label="Value" className="mono">{r.value}</td>
              <td className="right"><button type="button" className="btn btn--small" aria-label={`Copy ${r.name} value`}
                                            onClick={() => void navigator.clipboard.writeText(r.value)}>Copy</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
                <td className="cell-fact" data-label="First year">{o.available ? money(o.price) : "-"}</td>
                <td className="cell-fact" data-label="Then / year">{o.available ? money(o.renewalPrice) : "-"}</td>
                <td className="right">
                  {o.available && o.sellable
                    ? <button className="row-action" onClick={() => setPick(o)} disabled={!o.price}>Choose</button>
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
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<SupportCase | null | undefined>(undefined);
  const buy = useAction();
  const se = offer.verificationRequired;

  async function onBuy(e: FormEvent) {
    e.preventDefault();
    if (!offer.price) return;
    const r = await buy.run(() => api.registerDomain(tenant.tenantId, {
      domain: offer.domain, makePrimary: true, contact: contactForApi(c), acceptedPrice: offer.price!,
      ...(se ? { documentKey } : {}),
    }));
    if (r) { setResult(r.supportCase); onDone(); }
  }

  if (result !== undefined) {
    return (
      <>
        <Notice kind="ok"><strong>{offer.domain}</strong> is ordered. Its status is on the Domains tab.</Notice>
        {result ? <SupportCaseBox domain={offer.domain} tenantId={tenant.tenantId} supportCase={result} />
          : <p className="small muted">Live on {offer.domain} by itself <InfoTip label="What happens">Route 53 registers it (minutes to an hour), then the site goes live on {offer.domain}; www and the slug address 301 to it and dev.{offer.domain} goes on the dev site.</InfoTip></p>}
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
      {upload.busy && <Printing inline label="Uploading" />}
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
          {check.busy && <Printing inline label="Checking with the registry" />}
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

// --------------------------------------------------------------- records review
type Row = DnsRecord & { include: boolean; id: number; valuesText: string };
const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "SRV"];
let nextId = 1;

function rowsFrom(scan: DnsScan): Row[] {
  return scan.records.map((x) => ({ ...x, include: !x.skip, id: nextId++, valuesText: x.values.join("\n") }));
}

function recordsFor(rows: Row[]): DnsRecord[] {
  return rows.filter((r) => r.include && !r.skip).map((r) => ({
    name: r.name, type: r.type, ttl: Number(r.ttl) || 3600,
    values: r.valuesText.split("\n").map((v) => v.trim()).filter(Boolean),
  }));
}

/** The records a domain uses today (public DNS): ticked ones are copied into our zone before anything switches. */
function RecordsReview({ scan, rows, setRows }: { scan: DnsScan; rows: Row[]; setRows: (rows: Row[]) => void }) {
  const update = (id: number, patch: Partial<Row>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <>
      <p className="small">Records to copy <InfoTip label="Records to copy">Everything ticked is copied to our DNS zone. A record left out stops working once our name servers answer (email is the usual casualty: MX, SPF, DKIM). Add what the scan couldn't find (other DKIM selectors, own subdomains).</InfoTip></p>
      <div className="table-wrap">
        <table className="table records">
          <thead><tr><th /><th>Name</th><th>Type</th><th>TTL</th><th>Value(s), one per line</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.skip ? "muted" : undefined}>
                <td data-label="Copy"><input type="checkbox" checked={r.include && !r.skip} disabled={!!r.skip}
                           onChange={(e) => update(r.id, { include: e.target.checked })} aria-label={`Copy ${r.name} ${r.type}`} /></td>
                <td className="cell-title"><input className="input mono" aria-label="Name" value={r.name} disabled={!!r.skip} onChange={(e) => update(r.id, { name: e.target.value })} /></td>
                <td data-label="Type"><Select aria-label="Type" value={r.type} disabled={!!r.skip} onChange={(v) => update(r.id, { type: v })}
                  options={(TYPES.includes(r.type) ? TYPES : [r.type, ...TYPES]).map((t) => ({ value: t, label: t }))} /></td>
                <td data-label="TTL"><input className="input mono ttl" value={r.ttl} disabled={!!r.skip} onChange={(e) => update(r.id, { ttl: Number(e.target.value) || 0 })} /></td>
                <td data-label="Value(s)">{r.skip ? <span className="small">{r.skip}</span>
                  : <textarea className="input mono" rows={Math.min(4, Math.max(1, r.valuesText.split("\n").length))}
                              value={r.valuesText} onChange={(e) => update(r.id, { valuesText: e.target.value })} />}</td>
                <td>{!r.skip && <button type="button" className="btn btn--ghost btn--small" aria-label={`Remove ${r.name} ${r.type}`} onClick={() => setRows(rows.filter((x) => x.id !== r.id))}>✕</button>}</td>
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
    </>
  );
}

// --------------------------------------------------------------- connect (name servers)
function Connect({ tenant, initialDomain, onDone }: { tenant: Tenant; initialDomain?: string; onDone: () => void }) {
  const [domain, setDomain] = useState(initialDomain ?? "");
  const [scan, setScan] = useState<DnsScan | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [checked, setChecked] = useState(false);
  const [done, setDone] = useState<Zone | null>(null);
  const scanA = useAction();
  const connect = useAction();

  async function onScan(e: FormEvent) {
    e.preventDefault();
    const r = await scanA.run(() => api.scanDns(domain));
    if (!r) return;
    setScan(r);
    setDomain(r.domain);
    setChecked(false);
    setRows(rowsFrom(r));
  }

  async function onConnect() {
    if (!scan) return;
    const res = await connect.run(() => api.connectDomain(tenant.tenantId, { domain: scan.domain, makePrimary: true, records: recordsFor(rows) }));
    if (res) { setDone(res.zone); onDone(); }
  }

  if (done) {
    return (
      <>
        <Notice kind="ok"><strong>{done.domain}</strong>: DNS zone ready. Steps e-mailed to the restaurant.</Notice>
        {done.nameServers && <NameServerBox domain={done.domain} nameServers={done.nameServers} />}
        {done.restaurantSteps && <RestaurantText text={done.restaurantSteps} />}
      </>
    );
  }
  return (
    <>
      <form className="inline-form" onSubmit={onScan} noValidate>
        <Field label="Their domain" error={scanA.fields.domain} hint="e.g. restaurang.se">
          <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="restaurang.se" autoFocus />
        </Field>
        <button className="btn btn--primary" disabled={!domain.trim() || scanA.busy}>{scanA.busy ? "Scanning…" : "Scan DNS"}</button>
      </form>
      {scanA.busy && <Printing inline label="Reading their DNS" />}
      <ErrorNotice error={scanA.error} />
      {scan && (
        <>
          {!scan.registered && <Notice kind="warn">{scan.domain} has no name servers. Check the spelling.</Notice>}
          {scan.nameServers.length > 0 && <p className="small">DNS today: <span className="mono">{scan.nameServers.join(", ")}</span></p>}
          {scan.dnssec && <Notice kind="warn">DNSSEC is on: they turn it off before switching name servers.</Notice>}
          <RecordsReview scan={scan} rows={rows} setRows={setRows} />
          <ErrorNotice error={connect.error} />
          {Object.entries(connect.fields).map(([k, msg]) => <p key={k} className="small error-text">{k}: {msg}</p>)}
          <label className="check confirm"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            Records checked with the restaurant (email too)</label>
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

// ------------------------------------------------------ keep current registrar
function KeepRegistrar({ tenant, initialDomain, onBack, onDone }: {
  tenant: Tenant; initialDomain?: string; onBack: () => void; onDone: () => void;
}) {
  const [how, setHow] = useState<"records" | "nameservers">("records");
  return (
    <>
      <Back onClick={onBack} />
      <div className="seg" role="group" aria-label="How">
        <button type="button" className={`chip${how === "records" ? " chip--on" : ""}`} aria-pressed={how === "records"} onClick={() => setHow("records")}>Add records</button>
        <button type="button" className={`chip${how === "nameservers" ? " chip--on" : ""}`} aria-pressed={how === "nameservers"} onClick={() => setHow("nameservers")}>Change name servers</button>
        <InfoTip label="Records or name servers">Add records: they add a www and a dev CNAME and forward the bare domain to www at their registrar; www is the address (a CNAME can't sit on the bare domain). Change name servers: they point the four name servers at our DNS zone (records copied first); the bare domain works and is the address.</InfoTip>
      </div>
      {how === "records" ? <RecordsMode tenant={tenant} initialDomain={initialDomain} onDone={onDone} />
        : <Connect tenant={tenant} initialDomain={initialDomain} onDone={onDone} />}
    </>
  );
}

function RecordsMode({ tenant, initialDomain, onDone }: { tenant: Tenant; initialDomain?: string; onDone: () => void }) {
  const [domain, setDomain] = useState(initialDomain ?? "");
  const [zone, setZone] = useState<Zone | null>(null);
  const add = useAction();
  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const r = await add.run(() => api.recordsDomain(tenant.tenantId, domain));
    if (r) { setZone(r.zone); onDone(); }
  }
  if (zone) {
    return (
      <>
        <Notice kind="ok"><strong>{zone.canonicalHost ?? zone.domain}</strong>: steps e-mailed to the restaurant. We check DNS ourselves.</Notice>
        {zone.records && <RecordsTable records={zone.records} />}
        {zone.restaurantSteps && <RestaurantText text={zone.restaurantSteps} />}
      </>
    );
  }
  return (
    <form className="inline-form" onSubmit={onAdd} noValidate>
      <Field label="Their domain" error={add.fields.domain} hint="e.g. restaurang.se">
        <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="restaurang.se" autoFocus />
      </Field>
      <button className="btn btn--primary" disabled={!domain.trim() || add.busy}>{add.busy ? "Adding…" : "Add"}</button>
      <ErrorNotice error={add.fields.domain ? null : add.error} />
    </form>
  );
}

// ------------------------------------------------------------ move to Booqy
function MoveToBooqy({ tenant, initialDomain, onBack, onKeep, onDone }: {
  tenant: Tenant; initialDomain?: string; onBack: () => void; onKeep: (domain: string) => void; onDone: () => void;
}) {
  const [domain, setDomain] = useState(initialDomain ?? "");
  const [check, setCheck] = useState<TransferInCheck | null>(null);
  const [scan, setScan] = useState<DnsScan | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [c, setC] = useState<RegistrantContact>(() => contactFrom(tenant));
  const [authCode, setAuthCode] = useState("");
  const [documentKey, setDocumentKey] = useState("");
  const [uploading, setUploading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<{ zone: Zone; supportCase: SupportCase | null } | null>(null);
  const look = useAction();
  const go = useAction();

  async function onCheck(e: FormEvent) {
    e.preventDefault();
    setCheck(null); setScan(null); setConfirmed(false);
    const r = await look.run(async () => {
      const k = await api.transferInCheck(domain);
      const sc = k.supported ? await api.scanDns(k.domain) : null;
      return { k, sc };
    });
    if (!r) return;
    setCheck(r.k); setDomain(r.k.domain);
    if (r.sc) { setScan(r.sc); setRows(rowsFrom(r.sc)); }
  }

  async function onMove(e: FormEvent) {
    e.preventDefault();
    if (!check?.price || !scan) return;
    const r = await go.run(() => api.transferIn(tenant.tenantId, {
      domain: check.domain, authCode, records: recordsFor(rows), contact: contactForApi(c), acceptedPrice: check.price!,
      ...(check.verificationRequired ? { documentKey } : {}),
    }));
    if (r) { setResult(r); onDone(); }
  }

  if (result) {
    return (
      <>
        <Notice kind="ok"><strong>{result.zone.domain}</strong>: move started. Waiting for the owner's approval.</Notice>
        {result.supportCase && <SupportCaseBox domain={result.zone.domain} tenantId={tenant.tenantId} supportCase={result.supportCase} />}
        {result.zone.restaurantSteps && <RestaurantText text={result.zone.restaurantSteps} />}
      </>
    );
  }
  const goError = go.error instanceof ApiError ? go.error : null;
  return (
    <>
      <Back onClick={onBack} />
      <form className="inline-form" onSubmit={onCheck} noValidate>
        <Field label="Their domain" error={look.fields.domain} hint="e.g. restaurang.se">
          <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="restaurang.se" autoFocus />
        </Field>
        <button className="btn btn--primary" disabled={!domain.trim() || look.busy}>{look.busy ? "Checking…" : "Check"}</button>
      </form>
      {look.busy && <Printing inline label="Asking the registry" />}
      <ErrorNotice error={look.error} />
      {check && !check.supported && (
        <Notice kind="warn">
          <strong>{check.domain}</strong> can't be moved to Booqy. <button type="button" className="link" onClick={() => onKeep(check.domain)}>Keep current registrar</button>
        </Notice>
      )}
      {check?.supported && !check.transferable && (
        <>
          <Notice kind="warn">{check.lastError ?? check.reason ?? "It can't be moved right now."}</Notice>
          {check.lastErrorSv && <RestaurantText text={check.lastErrorSv} title="Restaurant (Swedish)" />}
          <button type="button" className="link" onClick={() => onKeep(check.domain)}>Keep current registrar instead</button>
        </>
      )}
      {check?.transferable && scan && (
        <form onSubmit={onMove} noValidate>
          <p className="small"><strong>{money(check.price)}</strong> incl. one more year, then {money(check.renewalPrice)}/year
            <InfoTip label="Price">Booqy pays; auto-renews. A failed move is not charged.</InfoTip></p>
          <RecordsReview scan={scan} rows={rows} setRows={setRows} />
          <ErrorNotice error={go.error} />
          {typeof goError?.extra?.lastErrorSv === "string" && <RestaurantText text={goError.extra.lastErrorSv} title="Restaurant (Swedish)" />}
          {goError?.code === "price_changed" && <Notice kind="warn">Check again to see the new price.</Notice>}
          <Field label="Transfer code" required error={go.fields.authCode}
                 hint="From their registrar (one.com: Domain, Transfer / EPP code)">
            <input className="input mono" value={authCode} onChange={(e) => setAuthCode(e.target.value)} autoComplete="off" />
          </Field>
          <RegistrantFields value={c} onChange={setC} fields={go.fields} />
          {check.verificationRequired && <RegistreringsbevisUpload tenantId={tenant.tenantId} error={go.fields.documentKey}
                                                                  onKey={setDocumentKey} onBusy={setUploading} />}
          <label className="check confirm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            Move {check.domain} for {money(check.price)}</label>
          <div className="row">
            <button className="btn btn--primary"
                    disabled={!confirmed || !authCode.trim() || go.busy || uploading || (!!check.verificationRequired && !documentKey)}>
              {go.busy ? "Starting…" : `Move ${check.domain}`}
            </button>
          </div>
        </form>
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

// ------------------------------------------------------------ test mapping
/** Dev console: example.se is mapped onto the test sites, main and dev. */
function TestMapping({ tenant, onDone }: { tenant: Tenant; onDone: () => void }) {
  const [domain, setDomain] = useState("");
  const [added, setAdded] = useState<{ stage: string; host: string }[] | null>(null);
  const add = useAction();
  const preview = testMapping(domain);
  return (
    <form noValidate onSubmit={async (e) => {
      e.preventDefault();
      const r = await add.run(() => api.addDomain(tenant.tenantId, domain, true));
      if (r) { setAdded(r.hosts ?? []); setDomain(""); onDone(); }
    }}>
      <ErrorNotice error={add.fields.domain ? null : add.error} />
      <Field label="Domain" error={add.fields.domain}>
        <input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.se" autoFocus />
      </Field>
      {preview && (
        <dl className="dl">
          <dt>main</dt><dd className="mono">{preview.main}</dd>
          <dt>dev</dt><dd className="mono">{preview.dev}</dd>
        </dl>
      )}
      <button className="btn btn--primary" disabled={!preview || add.busy}>{add.busy ? "Adding…" : "Add test mapping"}</button>
      {added && (
        <Notice kind="ok">
          Mapped: {added.map((h) => <span key={h.host} className="mono"> {h.host}</span>)}
        </Notice>
      )}
    </form>
  );
}
