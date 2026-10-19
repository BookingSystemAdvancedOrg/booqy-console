import { FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Card, ErrorNotice, Field, compact, useAction, useLoad } from "../components/ui";
import { formatOrgNumber, orgNumberProblem, vatFromOrgNumber } from "../orgNumber";
import { POSTAL_CODE_INPUT, formatPostalCode, postalCodeDigits } from "../postalCode";
import { PhoneInput } from "../components/PhoneInput";
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

// Field names as the API reports them -> the label the operator sees.
const LABELS: Record<string, string> = {
  name: "Restaurant / brand name", slug: "Slug", legalName: "Legal name", orgNumber: "Org. number",
  vatNumber: "VAT number", "address.street": "Street address", "address.postalCode": "Postal code",
  "address.city": "City", ownerName: "Owner name", ownerEmail: "Owner business email", ownerPhone: "Owner phone",
  contactEmail: "Contact email", contactPhone: "Contact phone", billingEmail: "Billing email",
  senderName: "Sender name", replyToEmail: "Reply-to email", planId: "Plan",
  "overrides.maxLocations": "Locations allowed", locations: "Locations", notes: "Notes",
};
const LOCATION_LABELS: Record<string, string> = { name: "name", address: "address", phone: "phone", email: "email" };

function labelFor(key: string): string {
  const loc = key.match(/^locations\.(\d+)\.(\w+)$/);
  if (loc) return `Location ${Number(loc[1]) + 1}: ${LOCATION_LABELS[loc[2]] ?? loc[2]}`;
  return LABELS[key] ?? key;
}

/** Field errors listed by label; each one jumps to its input. */
function FieldErrors({ fields }: { fields: Record<string, string> }) {
  const jump = (key: string) => {
    const el = document.getElementById(`f-${key}`) ?? document.getElementById(`f-${key.split(".")[0]}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  };
  return (
    <ul className="field-errors">
      {Object.entries(fields).map(([key, msg]) => (
        <li key={key}>
          <button type="button" className="linkish" onClick={() => jump(key)}>{labelFor(key)}</button>: {msg}
        </li>
      ))}
    </ul>
  );
}

export default function NewTenantPage() {
  const navigate = useNavigate();
  const plans = useLoad(() => api.plans());
  const { busy, error, fields, run } = useAction();

  const [f, setF] = useState({
    name: "", slug: "", legalName: "", orgNumber: "",
    street: "", postalCode: "", city: "",
    ownerName: "", ownerEmail: "", ownerPhone: "",
    contactEmail: "", contactPhone: "", billingEmail: "", senderName: "", replyToEmail: "",
    planId: "", maxLocations: "", notes: "",
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [locations, setLocations] = useState<LocationInput[]>([emptyLocation()]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    const value = k === "orgNumber" ? formatOrgNumber(e.target.value)
      : k === "postalCode" ? formatPostalCode(e.target.value) : e.target.value;
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

  const vatNumber = vatFromOrgNumber(f.orgNumber);
  const orgProblem = orgNumberProblem(f.orgNumber);

  // Why the button is disabled, in words - not a silently grey button.
  const missing = useMemo(() => {
    const out: string[] = [];
    if (!f.name) out.push("restaurant name");
    if (!f.slug) out.push("slug");
    if (!f.ownerName) out.push("owner name");
    if (!f.ownerEmail) out.push("owner email");
    if (!f.planId) out.push("a plan");
    return out;
  }, [f]);
  const tooManyLocations = locations.length > maxLocations;
  const canSubmit = missing.length === 0 && !tooManyLocations;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      ...compact({
        name: f.name, slug: f.slug, planId: f.planId, ownerName: f.ownerName, ownerEmail: f.ownerEmail,
        ownerPhone: f.ownerPhone, legalName: f.legalName, orgNumber: f.orgNumber, vatNumber,
        contactEmail: f.contactEmail, contactPhone: f.contactPhone, billingEmail: f.billingEmail,
        senderName: f.senderName, replyToEmail: f.replyToEmail, notes: f.notes,
      }),
      ...(addressGiven ? { address: { street: f.street, postalCode: postalCodeDigits(f.postalCode), city: f.city } } : {}),
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

      <Card title="1 · Restaurant company">
        <div className="grid">
          <Field label="Restaurant / brand name" required error={fields.name}>
            <input id="f-name" className="input" value={f.name} onChange={set("name")} placeholder="Pizzeria Roma" autoFocus />
          </Field>
          <Field label="Slug" required error={fields.slug}
                 hint={PLATFORM_DOMAIN ? `Website: ${f.slug || "slug"}.${PLATFORM_DOMAIN}` : "Lowercase id, used in the site address. Can't be changed later."}>
            <input id="f-slug" className="input mono" value={f.slug} onChange={(e) => { setSlugTouched(true); set("slug")(e); }} />
          </Field>
          <Field label="Legal name" error={fields.legalName}>
            <input id="f-legalName" className="input" value={f.legalName} onChange={set("legalName")} placeholder="Roma Restaurang AB" />
          </Field>
          <Field label="Org. number" error={fields.orgNumber ?? orgProblem} hint="10 digits, the dash is added for you">
            <input id="f-orgNumber" className="input mono" inputMode="numeric" maxLength={11} value={f.orgNumber}
                   onChange={set("orgNumber")} placeholder="556677-8899" />
          </Field>
          <Field label="VAT number" error={fields.vatNumber} hint="SE + org. number + 01, filled in from the org. number">
            <input id="f-vatNumber" className="input mono" value={vatNumber} readOnly tabIndex={-1}
                   placeholder="SE··········01" aria-describedby="f-orgNumber" />
          </Field>
          <Field label="Street address" error={fields["address.street"]}>
            <input id="f-address.street" className="input" value={f.street} onChange={set("street")} />
          </Field>
          <Field label="Postal code" error={fields["address.postalCode"]}>
            <input id="f-address.postalCode" className="input mono" {...POSTAL_CODE_INPUT} value={f.postalCode} onChange={set("postalCode")} />
          </Field>
          <Field label="City" error={fields["address.city"]}>
            <input id="f-address.city" className="input" value={f.city} onChange={set("city")} />
          </Field>
        </div>
      </Card>

      <Card title="2 · Owner login">
        <p className="muted small">This person gets an email with a temporary password and signs in to the restaurant admin app. Their account is tied to this customer permanently.</p>
        <div className="grid">
          <Field label="Owner name" required error={fields.ownerName}>
            <input id="f-ownerName" className="input" value={f.ownerName} onChange={set("ownerName")} />
          </Field>
          <Field label="Owner business email" required error={fields.ownerEmail} hint="Used to sign in">
            <input id="f-ownerEmail" className="input" type="email" value={f.ownerEmail} onChange={set("ownerEmail")} />
          </Field>
          <Field label="Owner phone" error={fields.ownerPhone}>
            <PhoneInput id="f-ownerPhone" className="input" value={f.ownerPhone} onChange={(v) => set("ownerPhone")({ target: { value: v } })} />
          </Field>
        </div>
      </Card>

      <Card title="3 · Contact & communication">
        <div className="grid">
          <Field label="Contact email" error={fields.contactEmail}>
            <input id="f-contactEmail" className="input" type="email" value={f.contactEmail} onChange={set("contactEmail")} />
          </Field>
          <Field label="Contact phone" error={fields.contactPhone}>
            <PhoneInput id="f-contactPhone" className="input" value={f.contactPhone} onChange={(v) => set("contactPhone")({ target: { value: v } })} />
          </Field>
          <Field label="Billing email" error={fields.billingEmail} hint="Where your invoices to them go">
            <input id="f-billingEmail" className="input" type="email" value={f.billingEmail} onChange={set("billingEmail")} />
          </Field>
          <Field label="Sender name" error={fields.senderName} hint="Email From name and SMS sender, max 11 chars">
            <input id="f-senderName" className="input" maxLength={11} value={f.senderName} onChange={set("senderName")} placeholder="Roma" />
          </Field>
          <Field label="Reply-to email" error={fields.replyToEmail} hint="Where guests' replies go">
            <input id="f-replyToEmail" className="input" type="email" value={f.replyToEmail} onChange={set("replyToEmail")} />
          </Field>
        </div>
      </Card>

      <Card title="4 · Plan">
        <ErrorNotice error={plans.error} />
        <div className="plans">
          {(plans.data ?? []).map((p, i) => (
            <label key={p.planId} className={`plan${f.planId === p.planId ? " plan--on" : ""}`}>
              <input id={i === 0 ? "f-planId" : undefined} type="radio" name="plan" value={p.planId} checked={f.planId === p.planId} onChange={set("planId")} />
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
            <input id="f-overrides.maxLocations" className="input" type="number" min={1} max={100} value={f.maxLocations} onChange={set("maxLocations")} />
          </Field>
        </div>
      </Card>

      <Card title={`5 · Locations (${locations.length} of ${maxLocations})`}
            actions={<button id="f-locations" type="button" className="btn btn--ghost" disabled={locations.length >= maxLocations}
                             onClick={() => setLocations([...locations, emptyLocation()])}>+ Add location</button>}>
        {fields.locations && <p className="field__msg">{fields.locations}</p>}
        {locations.map((loc, i) => {
          const errs = errorsFor(`locations.${i}.`);
          const upd = (k: keyof LocationInput) => (e: { target: { value: string } }) =>
            setLocations(locations.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)));
          return (
            <div key={i} className="loc-row">
              <div className="grid">
                <Field label="Location name" error={errs.name}><input id={`f-locations.${i}.name`} className="input" value={loc.name} onChange={upd("name")} placeholder="Roma Södermalm" /></Field>
                <Field label="Address" error={errs.address}><input id={`f-locations.${i}.address`} className="input" value={loc.address} onChange={upd("address")} placeholder="Götgatan 10, 118 46 Stockholm" /></Field>
                <Field label="Phone" error={errs.phone}><PhoneInput id={`f-locations.${i}.phone`} className="input" value={loc.phone ?? ""} onChange={(v) => upd("phone")({ target: { value: v } })} /></Field>
                <Field label="Email" error={errs.email}><input id={`f-locations.${i}.email`} className="input" value={loc.email} onChange={upd("email")} /></Field>
              </div>
              <button type="button" className="btn btn--ghost btn--small" onClick={() => setLocations(locations.filter((_, j) => j !== i))}>Remove</button>
            </div>
          );
        })}
        {locations.length === 0 && <p className="muted small">No locations yet - the owner (or you) can add them later.</p>}
      </Card>

      <Card title="6 · Internal notes">
        <Field label="Notes (only visible here)" error={fields.notes} wide>
          <textarea id="f-notes" className="input" rows={3} value={f.notes} onChange={set("notes")} placeholder="Contract, contact person, agreed price…" />
        </Field>
      </Card>

      <div className="submit-bar">
        <div className="submit-bar__info">
          {Object.keys(fields).length > 0 ? (
            <div className="notice notice--error" role="alert">
              <strong>Not created - {Object.keys(fields).length === 1 ? "1 field needs" : `${Object.keys(fields).length} fields need`} fixing:</strong>
              <FieldErrors fields={fields} />
            </div>
          ) : error ? (
            <ErrorNotice error={error} />
          ) : !canSubmit ? (
            <div className="small muted">
              {missing.length > 0 ? `Fill in ${missing.join(", ")} to create the customer.` : ""}
              {tooManyLocations ? ` The plan allows ${maxLocations} location${maxLocations > 1 ? "s" : ""} - remove one or raise "Locations allowed".` : ""}
            </div>
          ) : (
            <div className="small muted">
              On submit: tenant + locations are saved → owner invited by email → Stripe connected account created
              {PLATFORM_DOMAIN ? ` → ${f.slug || "slug"}.${PLATFORM_DOMAIN} goes live` : ""} → status becomes Active (about a minute).
            </div>
          )}
        </div>
        <button className="btn btn--primary" disabled={!canSubmit || busy}>{busy ? "Creating…" : "Create customer"}</button>
      </div>
    </form>
  );
}
