import { api } from "../api";
import type { DevTwin, Tenant } from "../types";
import { Card, ErrorNotice, fmtDate, useAction } from "./ui";
import { SaveButton } from "./save";
import { CopyButton } from "./CopyButton";
import "./devTwin.css";

/** The steps of a dev twin's seed, in the order they run (API devtwin.STEPS). */
export const DEV_TWIN_STEPS: [string, string][] = [
  ["owner", "Owner login"], ["stripe", "Stripe (test)"], ["location", "Location"],
  ["details", "Hours, rules, payments"], ["menu", "Menu"], ["layout", "Table layout"], ["printers", "Printer"],
  ["staff", "Staff"], ["dpa", "DPA"], ["google", "Google profile"], ["phone", "Phone assistant"],
];

const LABEL: Record<DevTwin["status"], string> = {
  queued: "Queued", running: "Setting up", ready: "Ready", partial: "Partly set up", failed: "Failed",
};
const TONE: Record<DevTwin["status"], string> = {
  queued: "provisioning", running: "provisioning", ready: "ready", partial: "provisioning", failed: "failed",
};

export const devTwinBusy = (t: Tenant) => t.devTwin?.status === "queued" || t.devTwin?.status === "running";

/** Dev console only: the customer's dev twin, Booqy's own copy with test data
 * in every Kom igång step, for whoever builds the restaurant's website. */
export function DevTwinCard({ tenant, onChanged }: { tenant: Tenant; onChanged: () => void }) {
  const a = useAction();
  const twin = tenant.devTwin;
  const busy = devTwinBusy(tenant);
  return (
    <Card title="Dev twin"
          info={<>This customer in dev, owned by Booqy, with test data in every Kom igång step. The site repo's dev branch
            talks to it. Refresh adds what is missing and keeps changes. Prod is the real restaurant.</>}
          actions={
            <SaveButton kind="plain" small type="button" label={twin ? "Refresh dev twin" : "Create dev twin"}
                        busy={a.busy || busy} busyLabel={busy ? "Setting up…" : "Starting…"} done={a.done} doneLabel="Started"
                        onClick={async () => { if (await a.run(() => api.devTwin(tenant.tenantId))) onChanged(); }} />
          }>
      <ErrorNotice error={a.error} />
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
          {Object.keys(twin.steps ?? {}).length > 0 && (
            <ul className="dev-twin__steps" aria-label="Kom igång steps">
              {DEV_TWIN_STEPS.filter(([id]) => twin.steps[id]).map(([id, label]) => {
                const step = twin.steps[id];
                return (
                  <li key={id} className={step.ok ? "is-ok" : "is-failed"} title={step.note}>
                    <span className="dev-twin__mark" aria-hidden="true">{step.ok ? "✓" : "!"}</span>
                    <span>{label}</span>
                    {!step.ok && step.note && <span className="dev-twin__note">{step.note}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
