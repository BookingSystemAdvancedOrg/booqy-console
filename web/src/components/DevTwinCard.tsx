import { api } from "../api";
import type { DevTwin, Tenant } from "../types";
import { Card, ErrorNotice, Notice, fmtDate, useAction } from "./ui";
import { SaveButton } from "./save";
import { CopyButton } from "./CopyButton";
import "./devTwin.css";

/** The steps of a dev twin's seed, in the order they run (API devtwin.STEPS). */
export const DEV_TWIN_STEPS: [string, string][] = [
  ["owner", "Owner login"], ["stripe", "Stripe (test)"], ["location", "Location"],
  ["details", "Hours, rules, payments"], ["menu", "Menu"], ["layout", "Table layout"], ["printers", "Printer"],
  ["staff", "Staff"], ["dpa", "DPA"], ["google", "Google profile"], ["phone", "Phone assistant"],
];

/** The steps of copying the real restaurant's public content (API devtwin_content.STEPS). */
export const CONTENT_STEPS: [string, string][] = [
  ["source", "Prod restaurant"], ["location", "Hours and rules"], ["menu", "Menu and photos"], ["layout", "Table layout"],
];

const LABEL: Record<DevTwin["status"], string> = {
  queued: "Queued", running: "Running", ready: "Ready", partial: "Partly done", failed: "Failed", skipped: "Skipped",
};
const TONE: Record<DevTwin["status"], string> = {
  queued: "provisioning", running: "provisioning", ready: "ready", partial: "provisioning", failed: "failed",
  skipped: "none",
};

/** Dev console: a prod customer's twin, a dev test customer, or neither (older dev customers). */
export function devKind(t: Pick<Tenant, "siteKind" | "twinOf" | "slug">): "twin" | "test" | null {
  if (t.siteKind === "test") return "test";
  return t.twinOf || t.siteKind === "prod-link" || t.slug === "anar" ? "twin" : null;
}

export function DevKindBadge({ kind }: { kind: "twin" | "test" | null | undefined }) {
  if (!kind) return null;
  return <span className={`dev-kind dev-kind--${kind}`}>{kind === "twin" ? "Twin of prod" : "Dev test"}</span>;
}

const busyOf = (s?: DevTwin) => s?.status === "queued" || s?.status === "running";
export const devTwinBusy = (t: Tenant) => busyOf(t.devTwin) || busyOf(t.devTwinContent);

function Steps({ steps, labels, name }: { steps: DevTwin["steps"]; labels: [string, string][]; name: string }) {
  if (Object.keys(steps ?? {}).length === 0) return null;
  return (
    <ul className="dev-twin__steps" aria-label={name}>
      {labels.filter(([id]) => steps[id]).map(([id, label]) => {
        const step = steps[id];
        return (
          <li key={id} className={step.ok ? "is-ok" : "is-failed"} title={step.note}>
            <span className="dev-twin__mark" aria-hidden="true">{step.ok ? "✓" : "!"}</span>
            <span>{label}</span>
            {!step.ok && step.note && <span className="dev-twin__note">{step.note}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Dev console only: the customer's dev twin, Booqy's own copy with test data
 * in every Kom igång step, for whoever builds the restaurant's website. */
export function DevTwinCard({ tenant, onChanged }: { tenant: Tenant; onChanged: () => void }) {
  const a = useAction();
  const c = useAction();
  const twin = tenant.devTwin;
  const content = tenant.devTwinContent;
  return (
    <Card title="Dev twin"
          info={<>This prod customer's copy in dev, owned by Booqy: test data in every Kom igång step, and the real
            restaurant's public content once its setup is finished. The site repo's dev branch talks to it. Refresh adds
            what is missing and keeps changes. Rules: site-template docs/DATA-RULES.md.</>}
          actions={
            <SaveButton kind="plain" small type="button" label={twin ? "Refresh dev twin" : "Create dev twin"}
                        busy={a.busy || busyOf(twin)} busyLabel={busyOf(twin) ? "Setting up…" : "Starting…"} done={a.done}
                        doneLabel="Started"
                        onClick={async () => { if (await a.run(() => api.devTwin(tenant.tenantId))) onChanged(); }} />
          }>
      <ErrorNotice error={a.error} />
      {tenant.twinProdOffboardedAt && (
        <Notice kind="warn">Prod offboarded the real customer on {fmtDate(tenant.twinProdOffboardedAt)}. This twin stays
          until you offboard it.</Notice>
      )}
      {!twin ? <p className="empty">Not set up yet.</p> : (
        <>
          <dl className="dl">
            <dt>Status</dt>
            <dd><span className={`status status--${TONE[twin.status]}`}>{LABEL[twin.status]}</span></dd>
            {twin.ownerEmail && <>
              <dt>Owner login</dt>
              <dd className="dev-twin__login">{twin.ownerEmail} <CopyButton text={twin.ownerEmail} label="Copy owner login" /></dd>
            </>}
            <dt>{twin.finishedAt ? "Finished" : "Requested"}</dt>
            <dd>{fmtDate(twin.finishedAt ?? twin.requestedAt)}</dd>
          </dl>
          {twin.error && <p className="dev-twin__error">{twin.error}</p>}
          <Steps steps={twin.steps} labels={DEV_TWIN_STEPS} name="Kom igång steps" />
        </>
      )}
      <section className="dev-twin__content" aria-label="Public content from prod">
        <div className="dev-twin__content-head">
          <h3>Public content from prod</h3>
          <SaveButton kind="plain" small type="button" label="Copy public content now"
                      busy={c.busy || busyOf(content)} busyLabel={busyOf(content) ? "Copying…" : "Starting…"} done={c.done}
                      doneLabel="Started"
                      onClick={async () => { if (await c.run(() => api.devTwinContent(tenant.tenantId))) onChanged(); }} />
        </div>
        <ErrorNotice error={c.error} />
        {!content ? <p className="empty">Not copied yet.</p> : (
          <>
            <dl className="dl">
              <dt>Status</dt>
              <dd><span className={`status status--${TONE[content.status]}`}>{LABEL[content.status]}</span></dd>
              <dt>Last copy</dt>
              <dd>{fmtDate(content.copiedAt)}</dd>
            </dl>
            <Steps steps={content.steps} labels={CONTENT_STEPS} name="Copy steps" />
          </>
        )}
      </section>
    </Card>
  );
}
