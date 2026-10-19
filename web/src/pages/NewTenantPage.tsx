import { FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Card, ErrorNotice, Field, compact, useAction, useLoad } from "../components/ui";
import type { LocationInput } from "../types";

const PLATFORM_DOMAIN = import.meta.env.VITE_PLATFORM_DOMAIN;

export function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[åä]/g, "a").replace(/ö/g, "o").replace(/é/g, "e")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 40).replace(/-+$/g, "");
}

const emptyLocation = (): LocationInput => ({ name: "", address: "", phone: "", email: "" });

export default function NewTenantPage() {
  const navigate = useNavigate();
  const plans = useLoad(() => api.plans());
  const { busy, error, fields, run } = useAction();

  const [f, setF] = useState({
    name: "", slug: "", legalName: "", orgNumber: "", vatNumber: "",
    street: "", postalCode: "", city: "",
    ownerName: "", ownerEmail: "", ownerPhone: "",
    contactEmail: "", contactPhone: "", billingEmail: "", senderName: "", replyToEmail: "",
    planId: "", maxLocations: "", notes: "",
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [locations, setLocations] = useState<LocationInput[]>([emptyLocation()]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setF((prev) => {
      const next = { ...prev, [k]: value };
      if (k === "name" && !slugTouched) next.slug = slugify(value);
      return next;
    });
  };

  const plan = plans.data?.find((p) => p.planId === f.planId) ?? null;
  const maxLocations = f.maxLocations ? Number(f.maxLocations) : plan?.maxLocations ?? 1;
  const addressGiven = f.street || f.postalCode || f.city;

  const errorsFor = (prefix: string) =>
    Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));

  const canSubmit = useMemo(
    () => f.name && f.slug && f.ownerName && f.ownerEmail && f.planId && locations.length <= maxLocations,
    [f, locations, maxLocations],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      ...compact({
        name: f.name, slug: f.slug, planId: f.planId, ownerName: f.ownerName, ownerEmail: f.ownerEmail,
        ownerPhone: f.ownerPhone, legalName: f.legalName, orgNumber: f.orgNumber, vatNumber: f.vatNumber,
        contactEmail: f.contactEmail, contactPhone: f.contactPhone, billingEmail: f.billingEmail,
        senderName: f.senderName, replyToEmail: f.replyToEmail, notes: f.notes,
      }),
      ...(addressGiven ? { address: { street: f.street, postalCode: f.postalCode, city: f.city } } : {}),
      ...(f.maxLocations ? { overrides: { maxLocations: Number(f.maxLocations) } } : {}),
      locations: locations.filter((l) => l.name || l.address).map((l) => compact(l) as LocationInput),
    };
    const res = await run(() => api.createTenant(body as never));
    if (res) navigate(`/tenants/${res.tenantId}?created=1`);
  }

  return (
    <form onSubmit={submit} className="form-page" noValidate>
      <div className="page-head">
        <div>
          <h1>New customer</h1>
          <p className="muted">Creates the tenant, invites the owner, opens their Stripe account and sets up their site - no deploy needed.</p>
        </div>
      </div>

      <ErrorNotice error={error} />

      <Card title="1 · Restaurant company">
        <div className="grid">
          <Field label="Restaurant / brand name" required error={fields.name}>
            <input className="input" value={f.name} onChange={set("name")} placeholder="Pizzeria Roma" autoFocus />
          </Field>
          <Field label="Slug" required error={fields.slug}
                 hint={PLATFORM_DOMAIN ? `Website: ${f.slug || "slug"}.${PLATFORM_DOMAIN}` : "Lowercase id, used in the site address. Can't be changed later."}>
            <input className="input mono" value={f.slug} onChange={(e) => { setSlugTouched(true); set("slug")(e); }} />
          </Field>
          <Field label="Legal name" error={fields.legalName}>
            <input className="input" value={f.legalName} onChange={set("legalName")} placeholder="Roma Restaurang AB" />
          </Field>
          <Field label="Org. number" error={fields.orgNumber} hint="NNNNNN-NNNN">
            <input className="input mono" value={f.orgNumber} onChange={set("orgNumber")} placeholder="556677-8899" />
          </Field>
          <Field label="VAT number" error={fields.vatNumber} hint="SE + 12 digits">
            <input className="input mono" value={f.vatNumber} onChange={set("vatNumber")} placeholder="SE556677889901" />
          </Field>
          <Field label="Street address" error={fields["address.street"]}>
            <input className="input" value={f.street} onChange={set("street")} />
          </Field>
          <Field label="Postal code" error={fields["address.postalCode"]}>
            <input className="input" value={f.postalCode} onChange={set("postalCode")} placeholder="111 22" />
          </Field>
          <Field label="City" error={fields["address.city"]}>
            <input className="input" value={f.city} onChange={set("city")} />
          </Field>
        </div>
      </Card>

      <Card title="2 · Owner login">
        <p className="muted small">This person gets an email with a temporary password and signs in to the restaurant admin app. Their account is tied to this customer permanently.</p>
        <div className="grid">
          <Field label="Owner name" required error={fields.ownerName}>
            <input className="input" value={f.ownerName} onChange={set("ownerName")} />
          </Field>
          <Field label="Owner business email" required error={fields.ownerEmail} hint="Used to sign in">
            <input className="input" type="email" value={f.ownerEmail} onChange={set("ownerEmail")} />
          </Field>
          <Field label="Owner phone" error={fields.ownerPhone}>
            <input className="input" type="tel" value={f.ownerPhone} onChange={set("ownerPhone")} placeholder="+46 70 123 45 67" />
          </Field>
        </div>
      </Card>

      <Card title="3 · Contact & communication">
        <div className="grid">
          <Field label="Contact email" error={fields.contactEmail}>
            <input className="input" type="email" value={f.contactEmail} onChange={set("contactEmail")} />
          </Field>
          <Field label="Contact phone" error={fields.contactPhone}>
            <input className="input" type="tel" value={f.contactPhone} onChange={set("contactPhone")} />
          </Field>
          <Field label="Billing email" error={fields.billingEmail} hint="Where your invoices to them go">
            <input className="input" type="email" value={f.billingEmail} onChange={set("billingEmail")} />
          </Field>
          <Field label="Sender name" error={fields.senderName} hint="Email From name and SMS sender, max 11 chars">
            <input className="input" maxLength={11} value={f.senderName} onChange={set("senderName")} placeholder="Roma" />
          </Field>
          <Field label="Reply-to email" error={fields.replyToEmail} hint="Where guests' replies go">
            <input className="input" type="email" value={f.replyToEmail} onChange={set("replyToEmail")} />
          </Field>
        </div>
      </Card>

      <Card title="4 · Plan">
        <ErrorNotice error={plans.error} />
        <div className="plans">
          {(plans.data ?? []).map((p) => (
            <label key={p.planId} className={`plan${f.planId === p.planId ? " plan--on" : ""}`}>
              <input type="radio" name="plan" value={p.planId} checked={f.planId === p.planId} onChange={set("planId")} />
              <strong>{p.name}</strong>
              <span>{p.maxLocations} location{p.maxLocations > 1 ? "s" : ""}</span>
              <span className="small muted">{Object.entries(p.features).filter(([, on]) => on).map(([k]) => k).join(" · ")}</span>
            </label>
          ))}
        </div>
        {fields.planId && <p className="field__msg">{fields.planId}</p>}
        <div className="grid">
          <Field label="Locations allowed (override)" error={fields["overrides.maxLocations"]}
                 hint={plan ? `Leave empty for the plan's ${plan.maxLocations}` : "Pick a plan first"}>
            <input className="input" type="number" min={1} max={100} value={f.maxLocations} onChange={set("maxLocations")} />
          </Field>
        </div>
      </Card>

      <Card title={`5 · Locations (${locations.length} of ${maxLocations})`}
            actions={<button type="button" className="btn btn--ghost" disabled={locations.length >= maxLocations}
                             onClick={() => setLocations([...locations, emptyLocation()])}>+ Add location</button>}>
        {fields.locations && <p className="field__msg">{fields.locations}</p>}
        {locations.map((loc, i) => {
          const errs = errorsFor(`locations.${i}.`);
          const upd = (k: keyof LocationInput) => (e: { target: { value: string } }) =>
            setLocations(locations.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)));
          return (
            <div key={i} className="loc-row">
              <div className="grid">
                <Field label="Location name" error={errs.name}><input className="input" value={loc.name} onChange={upd("name")} placeholder="Roma Södermalm" /></Field>
                <Field label="Address" error={errs.address}><input className="input" value={loc.address} onChange={upd("address")} placeholder="Götgatan 10, 118 46 Stockholm" /></Field>
                <Field label="Phone" error={errs.phone}><input className="input" value={loc.phone} onChange={upd("phone")} /></Field>
                <Field label="Email" error={errs.email}><input className="input" value={loc.email} onChange={upd("email")} /></Field>
              </div>
              <button type="button" className="btn btn--ghost btn--small" onClick={() => setLocations(locations.filter((_, j) => j !== i))}>Remove</button>
            </div>
          );
        })}
        {locations.length === 0 && <p className="muted small">No locations yet - the owner (or you) can add them later.</p>}
      </Card>

      <Card title="6 · Internal notes">
        <Field label="Notes (only visible here)" error={fields.notes} wide>
          <textarea className="input" rows={3} value={f.notes} onChange={set("notes")} placeholder="Contract, contact person, agreed price…" />
        </Field>
      </Card>

      <div className="submit-bar">
        <div className="small muted">
          On submit: tenant + locations are saved → owner invited by email → Stripe connected account created
          {PLATFORM_DOMAIN ? ` → ${f.slug || "slug"}.${PLATFORM_DOMAIN} goes live` : ""} → status becomes Active (about a minute).
        </div>
        <button className="btn btn--primary" disabled={!canSubmit || busy}>{busy ? "Creating…" : "Create customer"}</button>
      </div>
    </form>
  );
}
