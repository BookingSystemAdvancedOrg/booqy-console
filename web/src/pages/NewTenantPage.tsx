import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { addDays, fmtDay, isoDay, periodOf, periodText } from "../finance";
import { Card, ErrorNotice, Field, Notice, Printing, compact, useAction, useLoad } from "../components/ui";
import { formatOrgNumber, orgNumberProblem, vatFromOrgNumber, vatPreview } from "../orgNumber";
import { POSTAL_CODE_INPUT, formatPostalCode, postalCodeDigits } from "../postalCode";
import { PhoneInput } from "../components/PhoneInput";
import type { Features, Limits, LocationInput } from "../types";
import { FEATURE_KEYS, FEATURE_LABELS, LIMIT_KEYS, LIMITS, type LimitKey } from "../contracts";
import { SaveButton, useDirty } from "../components/save";
import { CountUp, prefersReducedMotion } from "../components/motion";
import { DrawnTick, InfoTip, StepCard, StepProgress, Summary, burst, confetti, revealStep } from "../components/StepFlow";
import { playChime } from "../press";
import { STEPS, progressPct, stepOfField, stepProblems, type StepId } from "./newTenantSteps";
import { FreeFields } from "../components/FreeFields";
import { FREE_PLAN_ID, freeForm, freeInput, freeLabel } from "../free";

const PLATFORM_DOMAIN = import.meta.env.VITE_PLATFORM_DOMAIN;

/** Every contract feature, ticked or not. A key a plan or tenant still carries
    but the contract no longer has (a retired feature) is not shown or sent. */
export const featureKeys = (): string[] => [...FEATURE_KEYS];
/** Only the contract's keys of a feature map (drops retired ones). */
export const contractFeatures = (m: Features): Features =>
  Object.fromEntries(Object.entries(m).filter(([k]) => (FEATURE_KEYS as readonly string[]).includes(k)));
export const featureLabel = (k: string) => (FEATURE_LABELS as Record<string, { en: string }>)[k]?.en ?? k;
/** The input label of each contract limit (CONTRACTS.md 8.3); a new limit without one fails typecheck. */
export const LIMIT_LABELS: Record<LimitKey, string> = {
  siteBuilderAiEditsPerMonth: "AI site edits per month",
  phoneAgentMinutesPerMonth: "Phone agent minutes per month",
};
/** A plan's or tenant's value of a limit (else the contract default), as input text. */
export const limitValue = (k: LimitKey, limits?: Limits) => String(limits?.[k] ?? LIMITS[k].default);

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
  "address.city": "City", ownerName: "Owner full name", ownerEmail: "Owner business email", ownerPhone: "Owner phone",
  contactEmail: "Contact email", contactPhone: "Contact phone", billingEmail: "Billing email",
  senderName: "Sender name", replyToEmail: "Reply-to email", planId: "Plan",
  "overrides.maxLocations": "Locations allowed",
  ...Object.fromEntries(LIMIT_KEYS.map((k) => [`overrides.limits.${k}`, LIMIT_LABELS[k]])),
  "overrides.features": "Features", locations: "Locations", notes: "Notes",
  "billing.priceSek": "Monthly price", "billing.terms": "Terms", "billing.startDate": "Agreement start date",
  "billing.collectionMethod": "Invoicing",
};
const LOCATION_LABELS: Record<string, string> = { name: "name", address: "address", phone: "phone", email: "email" };

function labelFor(key: string): string {
  const loc = key.match(/^locations\.(\d+)\.(\w+)$/);
  if (loc) return `Location ${Number(loc[1]) + 1}: ${LOCATION_LABELS[loc[2]] ?? loc[2]}`;
  return LABELS[key] ?? key;
}

function jump(key: string) {
  const el = document.getElementById(`f-${key}`) ?? document.getElementById(`f-${key.split(".")[0]}`);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  el?.focus({ preventScroll: true });
}

/** A failed onboarding run (tenant.lastError, "Error: Cause") as the form
 * field to fix, when there is one. */
export function setupFailure(lastError: string | undefined): { fields: Record<string, string>; message: string } {
  const text = lastError ?? "Setup failed";
  if (text.startsWith("OwnerEmailInUse")) {
    return { fields: { ownerEmail: "Already the owner of another customer - use another address" }, message: text };
  }
  return { fields: {}, message: text.replace(/^[A-Za-z.]+: /, "") };
}

// Long enough for the slowest onboarding (Stripe); after that the customer
// page takes over, and keeps showing the progress.
const SETUP_POLL_MS = 2500;
const SETUP_MAX_MS = 180_000;
// How long the finish celebration shows before the setup screen (none with reduced motion).
const CELEBRATE_MS = 1100;

/** Field errors listed by label; each one jumps to its input. */
function FieldErrors({ fields }: { fields: Record<string, string> }) {
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

const BLANK = {
  name: "", slug: "", legalName: "", orgNumber: "",
  street: "", postalCode: "", city: "",
  ownerName: "", ownerEmail: "", ownerPhone: "",
  contactEmail: "", contactPhone: "", billingEmail: "", senderName: "", replyToEmail: "",
  planId: "", maxLocations: "", notes: "",
};

export default function NewTenantPage() {
  const navigate = useNavigate();
  const plans = useLoad(() => api.plans());
  const { busy, error, fields: apiFields, run } = useAction();
  // After Create: the tenant being set up, and what its onboarding said when it failed.
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"form" | "setup" | "failed">("form");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupFields, setSetupFields] = useState<Record<string, string>>({});
  const fields = useMemo(() => ({ ...setupFields, ...apiFields }), [setupFields, apiFields]);
  const saved = phase === "failed";      // plan, invoicing and locations were saved with the customer

  const [f, setF] = useState(BLANK);
  // Limit overrides as typed; empty means the plan's.
  const [limitEdits, setLimitEdits] = useState<Partial<Record<LimitKey, string>>>({});
  const [slugTouched, setSlugTouched] = useState(false);
  const [locations, setLocations] = useState<LocationInput[]>([emptyLocation()]);
  // Invoicing: the plan's price unless typed over, try-out or subscription terms, start now.
  const [price, setPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [terms, setTerms] = useState<"trial" | "subscription">("trial");
  const [startInvoicing, setStartInvoicing] = useState(true);
  const [startDate, setStartDate] = useState("");
  // The Free plan's period: three months from today (Stockholm), then Starter.
  const [free, setFree] = useState(() => freeForm());
  // Features ticked differently from the plan; cleared when another plan is picked.
  const [featureEdits, setFeatureEdits] = useState<Record<string, boolean>>({});
  useEffect(() => setFeatureEdits({}), [f.planId]);
  // Created: the celebration runs before setup (the customer exists already).
  const [won, setWon] = useState(false);
  const celebrateTimer = useRef<number | null>(null);
  useEffect(() => () => { if (celebrateTimer.current !== null) window.clearTimeout(celebrateTimer.current); }, []);
  // Anything typed is unsaved until Create; leaving asks first (not once it is created).
  const dirty = useDirty({ f, locations, limitEdits }, { f: BLANK, locations: [emptyLocation()], limitEdits: {} }, { guard: phase !== "setup" && !won });

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
  const features = { ...(plan?.features ?? {}), ...featureEdits };
  const featureOverrides = plan ? Object.fromEntries(Object.entries(featureEdits).filter(([k, on]) => !!plan.features[k] !== on)) : {};
  const limitOverrides: Limits = Object.fromEntries(LIMIT_KEYS.filter((k) => limitEdits[k]).map((k) => [k, Number(limitEdits[k])]));
  const isFree = f.planId === FREE_PLAN_ID;
  const shownPrice = isFree ? "" : priceTouched ? price : plan?.priceSek != null ? String(plan.priceSek) : "";
  const addressGiven = f.street || f.postalCode || f.city;
  // Billing counts from the start date; the first invoice is the 25th after that period (in arrears).
  const firstPeriod = periodOf(startDate || isoDay(new Date()));
  const firstInvoiceText = `First invoice on ${fmtDay(addDays(firstPeriod.end, 1))}, for ${periodText(firstPeriod.start, firstPeriod.end)}, pro rata from ${startDate ? fmtDay(startDate) : "today"}.`;

  const errorsFor = (prefix: string) =>
    Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));

  const vatNumber = vatFromOrgNumber(f.orgNumber);
  const orgProblem = orgNumberProblem(f.orgNumber);

  // Why the button is disabled, in words - not a silently grey button.
  const missing = useMemo(() => {
    const out: string[] = [];
    if (!f.name) out.push("restaurant name");
    if (!f.slug) out.push("slug");
    if (!f.ownerName) out.push("owner full name");
    if (!f.ownerEmail) out.push("owner email");
    if (!f.planId) out.push("a plan");
    return out;
  }, [f]);
  const tooManyLocations = locations.length > maxLocations;
  const canSubmit = missing.length === 0 && !tooManyLocations;


  // The steps: only the first is open at first; Done folds a step into its
  // summary and brings up the next one under it. Done steps stay done.
  const [done, setDone] = useState<boolean[]>(() => STEPS.map(() => false));
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]));
  const [reached, setReached] = useState(0);
  const [entering, setEntering] = useState<number | null>(0);
  const [attempted, setAttempted] = useState<Set<number>>(() => new Set());
  const [announce, setAnnounce] = useState("");
  const [reveal, setReveal] = useState<{ to: number | "submit"; n: number } | null>(null);
  const doneCount = done.filter(Boolean).length;
  const allDone = doneCount === STEPS.length;
  const pct = progressPct(doneCount);
  const stepInput = {
    name: f.name, slug: f.slug, orgProblem, ownerName: f.ownerName, ownerEmail: f.ownerEmail,
    contactEmail: f.contactEmail, billingEmail: f.billingEmail, replyToEmail: f.replyToEmail,
    planId: f.planId, locationCount: locations.length, maxLocations,
  };
  // A step's own problems show once Done was pressed on it, and go as they are fixed.
  const stepErrors: Record<string, string> = Object.assign({}, ...[...attempted].map((i) => stepProblems(STEPS[i].id, stepInput)));
  const errs: Record<string, string> = { ...stepErrors, ...fields };

  function completeStep(i: number) {
    const problems = stepProblems(STEPS[i].id, stepInput);
    setAttempted((prev) => new Set(prev).add(i));
    const firstProblem = Object.keys(problems)[0];
    if (firstProblem) {
      window.setTimeout(() => jump(firstProblem), 0);
      return;
    }
    const nowDone = done.map((v, j) => v || j === i);
    const count = nowDone.filter(Boolean).length;
    const next = i === reached && i + 1 < STEPS.length ? i + 1 : null;
    setDone(nowDone);
    setOpen((prev) => {
      const n = new Set(prev);
      n.delete(i);
      if (next !== null) n.add(next);
      return n;
    });
    if (next !== null) { setReached(next); setEntering(next); }
    // where to go: the new step, else the next one still open, else Create
    const stillOpen = [...open].filter((j) => j !== i).sort((a, b) => a - b)[0];
    const to = next ?? stillOpen ?? (count === STEPS.length ? "submit" : null);
    if (to !== null) setReveal({ to, n: Date.now() });
    setAnnounce(next !== null ? `Next: ${STEPS[next].title}`
      : count === STEPS.length ? "All done. Ready to create." : `${STEPS[i].title} done`);
    playChime("chime");
    window.requestAnimationFrame?.(() => burst(document.querySelector(`#step-${STEPS[i].id} .step__num`)));
  }

  function editStep(i: number) {
    setOpen((prev) => new Set(prev).add(i));
    setReveal({ to: i, n: Date.now() });
  }

  // After a step opens: scroll it in under the bar and focus its first field.
  useEffect(() => {
    if (!reveal) return;
    if (reveal.to === "submit") {
      const btn = document.querySelector<HTMLElement>(".submit-bar button[type='submit']");
      btn?.scrollIntoView?.({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      btn?.focus({ preventScroll: true });
    } else {
      revealStep(document.getElementById(`step-${STEPS[reveal.to].id}`));
    }
  }, [reveal]);

  // A field the API (or a failed setup) points at opens its step, so the jump lands on it.
  const errorKeys = Object.keys(fields).join("|");
  useEffect(() => {
    if (!errorKeys) return;
    setOpen((prev) => {
      const n = new Set(prev);
      for (const k of errorKeys.split("|")) { const st = stepOfField(k); if (st >= 0) n.add(st); }
      return n;
    });
  }, [errorKeys]);

  const stepProps = (i: number) => ({
    id: STEPS[i].id, index: i, total: STEPS.length, title: STEPS[i].title as string,
    open: open.has(i), done: done[i], entering: entering === i,
    onDone: () => completeStep(i), onEdit: () => editStep(i),
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (won || busy) return;   // created already (the celebration runs), or on its way
    const body = {
      ...compact({
        name: f.name, slug: f.slug, planId: f.planId, ownerName: f.ownerName, ownerEmail: f.ownerEmail,
        ownerPhone: f.ownerPhone, legalName: f.legalName, orgNumber: f.orgNumber, vatNumber,
        contactEmail: f.contactEmail, contactPhone: f.contactPhone, billingEmail: f.billingEmail,
        senderName: f.senderName, replyToEmail: f.replyToEmail, notes: f.notes,
      }),
      ...(addressGiven ? { address: { street: f.street, postalCode: postalCodeDigits(f.postalCode), city: f.city } } : {}),
      ...(f.maxLocations || Object.keys(limitOverrides).length || Object.keys(featureOverrides).length ? {
        overrides: {
          ...(f.maxLocations ? { maxLocations: Number(f.maxLocations) } : {}),
          ...(Object.keys(featureOverrides).length ? { features: featureOverrides } : {}),
          ...(Object.keys(limitOverrides).length ? { limits: limitOverrides } : {}),
        },
      } : {}),
      locations: locations.filter((l) => l.name || l.address).map((l) => compact(l) as LocationInput),
      billing: compact({
        terms, startInvoicing, priceSek: shownPrice !== "" ? Number(shownPrice) : undefined,
        startDate: startInvoicing && startDate ? startDate : undefined,
      }),
      ...(isFree ? { free: freeInput(free) } : {}),
    };
    if (saved && tenantId) {
      // Fix and run setup again: the profile and owner fields, then a new onboarding run.
      const patch = {
        ...compact({
          name: f.name, legalName: f.legalName, orgNumber: f.orgNumber, vatNumber, contactEmail: f.contactEmail,
          contactPhone: f.contactPhone, billingEmail: f.billingEmail, senderName: f.senderName,
          replyToEmail: f.replyToEmail, notes: f.notes, ownerName: f.ownerName, ownerEmail: f.ownerEmail,
          ownerPhone: f.ownerPhone,
        }),
        ...(addressGiven ? { address: { street: f.street, postalCode: postalCodeDigits(f.postalCode), city: f.city } } : {}),
      };
      const ok = await run(async () => { await api.updateTenant(tenantId, patch); return api.retryOnboarding(tenantId); });
      if (ok) { setSetupFields({}); setSetupError(null); setPhase("setup"); }
      return;
    }
    const res = await run(() => api.createTenant(body as never));
    if (res) {
      // The big one: the bar shines, confetti, the fanfare; then setup as before.
      setTenantId(res.tenantId);
      setWon(true);
      setAnnounce(`${f.name} created`);
      playChime("fanfare");
      const shower = confetti();
      if (shower) celebrateTimer.current = window.setTimeout(() => { celebrateTimer.current = null; setPhase("setup"); }, CELEBRATE_MS);
      else setPhase("setup");
    }
  }

  // While onboarding runs: the printing receipt, then the customer page on
  // success, or back to the form with the field to fix on failure.
  useEffect(() => {
    if (phase !== "setup" || !tenantId) return;
    const started = Date.now();
    const id = window.setInterval(async () => {
      try {
        const { tenant } = await api.tenant(tenantId);
        if (tenant.status === "provisioning_failed") {
          const failure = setupFailure(tenant.lastError);
          setSetupFields(failure.fields);
          setSetupError(Object.keys(failure.fields).length ? null : failure.message);
          setWon(false);
          setEntering(null);   // back on the form: nothing rises in again
          setPhase("failed");
        } else if (tenant.status !== "provisioning" || Date.now() - started > SETUP_MAX_MS) {
          navigate(`/tenants/${tenantId}${tenant.status === "provisioning" ? "?created=1" : ""}`);
        }
      } catch {
        // a blip: the next tick tries again
      }
    }, SETUP_POLL_MS);
    return () => window.clearInterval(id);
  }, [phase, tenantId, navigate]);

  // Errors take you to the first field to fix.
  const firstError = Object.keys(fields)[0];
  useEffect(() => {
    if (firstError) window.setTimeout(() => jump(firstError), 50);
  }, [firstError, phase]);

  if (phase === "setup") {
    return (
      <div className="form-page">
        <div className="page-head">
          <div>
            <h1>{f.name}</h1>
            <p className="muted">Setting up: inviting {f.ownerEmail}, opening the Stripe account{PLATFORM_DOMAIN ? ` and ${f.slug}.${PLATFORM_DOMAIN}` : ""}. About a minute.</p>
          </div>
        </div>
        <Card title="Setting up the customer">
          <Printing label={`Setting up ${f.name}`} />
          <p className="small muted">You can leave this page: the customer is saved and setup carries on. If something needs fixing, you'll be taken to it here.</p>
        </Card>
      </div>
    );
  }

  const filledLocations = locations.filter((l) => l.name || l.address);
  const summaries: Record<StepId, [string, ReactNode][]> = {
    company: [["Name", f.name], ["Site", PLATFORM_DOMAIN ? `${f.slug}.${PLATFORM_DOMAIN}` : f.slug], ["Org. no.", f.orgNumber], ["City", f.city]],
    owner: [["Owner", f.ownerName], ["Email", f.ownerEmail], ["Phone", f.ownerPhone]],
    contact: [["Contact", f.contactEmail || f.contactPhone], ["Billing", f.billingEmail], ["Sender", f.senderName], ["Reply-to", f.replyToEmail]],
    plan: [["Plan", plan?.name], ["Price", isFree ? freeLabel(free.noEnd ? null : free.until)
                                    : shownPrice !== "" ? <CountUp value={Number(shownPrice)} format={(n) => `${Math.round(n)} kr/mo`} /> : ""],
           ["Terms", terms === "trial" ? "Try-out" : "Subscription"], ["Starts", startInvoicing ? (startDate ? fmtDay(startDate) : "Today") : "Later"]],
    locations: [["Locations", <CountUp value={filledLocations.length} format={(n) => `${Math.round(n)} of ${maxLocations}`} />],
                ["Names", filledLocations.map((l) => l.name || l.address).join(", ")]],
    notes: [["Notes", f.notes.length > 60 ? `${f.notes.slice(0, 60)}…` : f.notes]],
  };
  const submitText = `On submit: tenant + locations are saved, owner invited by email, Stripe connected account created${PLATFORM_DOMAIN ? `, ${f.slug || "slug"}.${PLATFORM_DOMAIN} goes live` : ""}, status becomes Active (about a minute).${startInvoicing ? ` The agreement starts${startDate ? ` on ${fmtDay(startDate)}` : " today"} ${isFree ? `with no charge (${freeLabel(free.noEnd ? null : free.until)})` : `at ${shownPrice || "the plan's price"}${shownPrice ? " kr" : ""} a month ex VAT`} (${terms === "trial" ? "try-out" : "subscription"}). ${isFree ? "" : firstInvoiceText}` : ""}`;

  return (
    <form onSubmit={submit} className={`form-page${saved ? " form-page--back" : ""}`} noValidate>
      <div className="page-head">
        <div>
          <h1>New customer <InfoTip label="What Create does">Creates the tenant, invites the owner, opens their Stripe account and sets up their site. No deploy needed.</InfoTip></h1>
        </div>
      </div>

      <StepProgress pct={pct} done={doneCount} total={STEPS.length} current={STEPS[Math.min(doneCount, STEPS.length - 1)].title} won={won} still={saved} />
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>

      <StepCard {...stepProps(0)} summary={<Summary items={summaries.company} />}>
        <div className="grid">
          <Field label="Restaurant / brand name" required error={errs.name}>
            <input id="f-name" className="input" value={f.name} onChange={set("name")} placeholder="Pizzeria Roma" autoFocus />
          </Field>
          <Field label="Slug" required error={errs.slug}
                 hint={PLATFORM_DOMAIN ? `Website: ${f.slug || "slug"}.${PLATFORM_DOMAIN}` : "Lowercase id, used in the site address. Can't be changed later."}>
            <input id="f-slug" className="input mono" disabled={saved} value={f.slug} onChange={(e) => { setSlugTouched(true); set("slug")(e); }} />
          </Field>
          <Field label="Legal name" error={errs.legalName}>
            <input id="f-legalName" className="input" value={f.legalName} onChange={set("legalName")} placeholder="Roma Restaurang AB" />
          </Field>
          <Field label="Org. number" error={errs.orgNumber ?? orgProblem} hint="10 digits, the dash is added for you">
            <input id="f-orgNumber" className="input mono" inputMode="numeric" maxLength={11} value={f.orgNumber}
                   onChange={set("orgNumber")} placeholder="556677-8899" />
          </Field>
          <Field label="VAT number" error={errs.vatNumber} hint="SE + org. number + 01, filled in from the org. number">
            <input id="f-vatNumber" className="input mono" value={vatPreview(f.orgNumber)} readOnly tabIndex={-1}
                   placeholder="SE··········01" aria-describedby="f-orgNumber" />
          </Field>
          <Field label="Street address" error={errs["address.street"]}>
            <input id="f-address.street" className="input" value={f.street} onChange={set("street")} />
          </Field>
          <Field label="Postal code" error={errs["address.postalCode"]}>
            <input id="f-address.postalCode" className="input mono" {...POSTAL_CODE_INPUT} value={f.postalCode} onChange={set("postalCode")} />
          </Field>
          <Field label="City" error={errs["address.city"]}>
            <input id="f-address.city" className="input" value={f.city} onChange={set("city")} />
          </Field>
        </div>
      </StepCard>

      {reached >= 1 && (
        <StepCard {...stepProps(1)} summary={<Summary items={summaries.owner} />}
                  info={<InfoTip label="About the owner login">This person gets an email with a temporary password and signs in to the restaurant admin app. Their account is tied to this customer permanently.</InfoTip>}>
          <div className="grid">
            <Field label="Owner full name" required error={errs.ownerName}>
              <input id="f-ownerName" className="input" value={f.ownerName} onChange={set("ownerName")} />
            </Field>
            <Field label="Owner business email" required error={errs.ownerEmail} hint="Used to sign in">
              <input id="f-ownerEmail" className="input" type="email" value={f.ownerEmail} onChange={set("ownerEmail")} />
            </Field>
            <Field label="Owner phone" error={errs.ownerPhone}>
              <PhoneInput id="f-ownerPhone" className="input" value={f.ownerPhone} onChange={(v) => set("ownerPhone")({ target: { value: v } })} />
            </Field>
          </div>
        </StepCard>
      )}

      {reached >= 2 && (
        <StepCard {...stepProps(2)} summary={<Summary items={summaries.contact} />}>
          <div className="grid">
            <Field label="Contact email" error={errs.contactEmail}>
              <input id="f-contactEmail" className="input" type="email" value={f.contactEmail} onChange={set("contactEmail")} />
            </Field>
            <Field label="Contact phone" error={errs.contactPhone}>
              <PhoneInput id="f-contactPhone" className="input" value={f.contactPhone} onChange={(v) => set("contactPhone")({ target: { value: v } })} />
            </Field>
            <Field label="Billing email" error={errs.billingEmail} hint="Where your invoices to them go">
              <input id="f-billingEmail" className="input" type="email" value={f.billingEmail} onChange={set("billingEmail")} />
            </Field>
            <Field label="Sender name" error={errs.senderName} hint="Email From name and SMS sender, max 11 chars">
              <input id="f-senderName" className="input" maxLength={11} value={f.senderName} onChange={set("senderName")} placeholder="Roma" />
            </Field>
            <Field label="Reply-to email" error={errs.replyToEmail} hint="Where guests' replies go">
              <input id="f-replyToEmail" className="input" type="email" value={f.replyToEmail} onChange={set("replyToEmail")} />
            </Field>
          </div>
        </StepCard>
      )}

      {saved && reached >= 3 && <Notice kind="info">Plan, invoicing and locations were saved with the customer: change them on the customer page later.</Notice>}
      {reached >= 3 && (
        <StepCard {...stepProps(3)} summary={<Summary items={summaries.plan} />} locked={saved}>
          <fieldset className="fieldset-plain" disabled={saved}>
            <ErrorNotice error={plans.error} />
            <div className="plans">
              {(plans.data ?? []).map((p, i) => (
                <label key={p.planId} className={`plan${f.planId === p.planId ? " plan--on" : ""}`}>
                  <input id={i === 0 ? "f-planId" : undefined} type="radio" name="plan" value={p.planId} checked={f.planId === p.planId} onChange={set("planId")} />
                  <strong>{p.name}</strong>
                  <span>{p.free ? `No charge, ${p.maxLocations} locations` : `${p.maxLocations} location${p.maxLocations > 1 ? "s" : ""}`}</span>
                  <span className="small muted">{Object.entries(contractFeatures(p.features)).filter(([, on]) => on).map(([k]) => featureLabel(k)).join(" · ")}</span>
                </label>
              ))}
            </div>
            {errs.planId && <p className="field__msg">{errs.planId}</p>}
            {isFree && (
              <FreeFields value={free} onChange={setFree} plans={plans.data ?? []}
                          errors={{ until: errs["free.until"], thenPlanId: errs["free.thenPlanId"] }} />
            )}
            <div className="grid">
              <Field label="Locations allowed (override)" error={errs["overrides.maxLocations"]}
                     hint={plan ? `Leave empty for the plan's ${plan.maxLocations}` : "Pick a plan first"}>
                <input id="f-overrides.maxLocations" className="input" type="number" min={1} max={100} value={f.maxLocations} onChange={set("maxLocations")} />
              </Field>
              {LIMIT_KEYS.map((k) => (
                <Field key={k} label={`${LIMIT_LABELS[k]} (override)`} error={errs[`overrides.limits.${k}`]}
                       hint={plan ? `Leave empty for the plan's ${limitValue(k, plan.limits)}; used with ${featureLabel(LIMITS[k].feature)}` : "Pick a plan first"}>
                  <input id={`f-overrides.limits.${k}`} className="input" type="number" min={LIMITS[k].min} max={LIMITS[k].max}
                         value={limitEdits[k] ?? ""} onChange={(e) => setLimitEdits({ ...limitEdits, [k]: e.target.value })} />
                </Field>
              ))}
              {!isFree && (
                <Field label="Monthly price, SEK ex VAT" error={errs["billing.priceSek"]}
                       hint={plan?.priceSek != null ? `The plan's price is ${plan.priceSek} kr; type over it for a customer's own price` : "Pick a plan to see its price"}>
                  <input id="f-billing.priceSek" className="input mono" type="number" min={0} step={1} value={shownPrice}
                         onChange={(e) => { setPriceTouched(true); setPrice(e.target.value); }} />
                </Field>
              )}
              <div className="field">
                <span className="field__label">Features</span>
                {plan ? (
                  <div className="checks">
                    {featureKeys().map((k) => (
                      <label key={k} className="check">
                        <input type="checkbox" checked={!!features[k]} onChange={(e) => setFeatureEdits({ ...featureEdits, [k]: e.target.checked })} /> {featureLabel(k)}
                      </label>
                    ))}
                  </div>
                ) : <span className="field__hint">Pick a plan first</span>}
              </div>
            </div>

            <div className="step__sub">
              <h3>Invoicing</h3>
              <InfoTip label="How invoicing works">
                Invoiced in arrears through Stripe: on the 25th, one invoice for the period from the 25th to the 24th that has just
                ended, with the monthly price (pro rata by days for a part period) plus 25 % VAT, emailed with 30 days to pay.
                SMS are included in the price; Free has no charge. A try-out customer can leave with any period and becomes a subscription by itself after
                6 months, or when you convert them; a subscription customer has 3 months' notice.
              </InfoTip>
            </div>
            <div className="choices">
              <label className={`choice${terms === "trial" ? " choice--on" : ""}`}>
                <input id="f-billing.terms" type="radio" name="terms" checked={terms === "trial"} onChange={() => setTerms("trial")} />
                <strong>Try-out period</strong>
                <span className="muted small">Can leave with any period. Becomes a subscription after 6 months.</span>
              </label>
              <label className={`choice${terms === "subscription" ? " choice--on" : ""}`}>
                <input type="radio" name="terms" checked={terms === "subscription"} onChange={() => setTerms("subscription")} />
                <strong>Subscription</strong>
                <span className="muted small">3 months' notice.</span>
              </label>
            </div>
            {errs["billing.terms"] && <p className="field__msg">{errs["billing.terms"]}</p>}
            <label className="check">
              <input type="checkbox" checked={startInvoicing} onChange={(e) => setStartInvoicing(e.target.checked)} />
              Start the agreement when the customer is created
            </label>
            {startInvoicing && (
              <div className="grid">
                <Field label="Agreement starts (optional)" error={errs["billing.startDate"]}
                       hint={`Empty = today. Nothing is charged now. ${isFree ? "No invoice while on Free." : firstInvoiceText}`}>
                  <input id="f-billing.startDate" className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </Field>
              </div>
            )}
            {!startInvoicing && <p className="muted small">You can start it later from the customer's Billing tab.</p>}
          </fieldset>
        </StepCard>
      )}

      {reached >= 4 && (
        <StepCard {...stepProps(4)} title={`Locations (${locations.length} of ${maxLocations})`} summary={<Summary items={summaries.locations} />} locked={saved}>
          <fieldset className="fieldset-plain" disabled={saved}>
            {errs.locations && <p className="field__msg">{errs.locations}</p>}
            {locations.map((loc, i) => {
              const le = errorsFor(`locations.${i}.`);
              const upd = (k: keyof LocationInput) => (e: { target: { value: string } }) =>
                setLocations(locations.map((l, j) => (j === i ? { ...l, [k]: e.target.value } : l)));
              return (
                <div key={i} className="loc-row">
                  <div className="grid">
                    <Field label="Location name" error={le.name}><input id={`f-locations.${i}.name`} className="input" value={loc.name} onChange={upd("name")} placeholder="Roma Södermalm" /></Field>
                    <Field label="Address" error={le.address}><input id={`f-locations.${i}.address`} className="input" value={loc.address} onChange={upd("address")} placeholder="Götgatan 10, 118 46 Stockholm" /></Field>
                    <Field label="Phone" error={le.phone}><PhoneInput id={`f-locations.${i}.phone`} className="input" value={loc.phone ?? ""} onChange={(v) => upd("phone")({ target: { value: v } })} /></Field>
                    <Field label="Email" error={le.email}><input id={`f-locations.${i}.email`} className="input" value={loc.email} onChange={upd("email")} /></Field>
                  </div>
                  <button type="button" className="btn btn--ghost btn--small" onClick={() => setLocations(locations.filter((_, j) => j !== i))}>Remove</button>
                </div>
              );
            })}
            {locations.length === 0 && <p className="muted small">No locations yet: the owner (or you) can add them later.</p>}
            <button id="f-locations" type="button" className="btn btn--ghost btn--small step__add" disabled={locations.length >= maxLocations}
                    onClick={() => setLocations([...locations, emptyLocation()])}>+ Add location</button>
          </fieldset>
        </StepCard>
      )}

      {reached >= 5 && (
        <StepCard {...stepProps(5)} summary={<Summary items={summaries.notes} />}>
          <Field label="Notes (only visible here)" error={errs.notes} wide>
            <textarea id="f-notes" className="input" rows={3} value={f.notes} onChange={set("notes")} placeholder="Contract, contact person, agreed price…" />
          </Field>
        </StepCard>
      )}

      {(allDone || saved) && (
        <div className="submit-bar submit-bar--enter">
          <div className="submit-bar__info">
            {Object.keys(fields).length > 0 ? (
              <div className="notice notice--error" role="alert">
                <strong>{saved ? "Setup stopped" : "Not created"} - {Object.keys(fields).length === 1 ? "1 field needs" : `${Object.keys(fields).length} fields need`} fixing:</strong>
                <FieldErrors fields={fields} />
              </div>
            ) : saved && setupError ? (
              <div className="notice notice--error" role="alert">
                <strong>Setup stopped:</strong> {setupError} Fix it if it's in the form, then <strong>Save and retry</strong>.
              </div>
            ) : error ? (
              <ErrorNotice error={error} />
            ) : !canSubmit ? (
              <div className="small muted">
                {missing.length > 0 ? `Fill in ${missing.join(", ")} to create the customer.` : ""}
                {tooManyLocations ? ` The plan allows ${maxLocations} location${maxLocations > 1 ? "s" : ""} - remove one or raise "Locations allowed".` : ""}
              </div>
            ) : (
              <div className="submit-ready">
                <DrawnTick /> {f.name || "Ready"}
                <InfoTip label="What happens on Create">{submitText}</InfoTip>
              </div>
            )}
          </div>
          <SaveButton label={saved ? "Save and retry" : "Create customer"} busy={busy} busyLabel={saved ? "Saving…" : "Creating…"}
                      done={won} doneLabel="Created"
                      dirty={dirty.dirty} allowClean disabled={!canSubmit} hint={false} />
        </div>
      )}
    </form>
  );
}
