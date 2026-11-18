import { Link } from "react-router-dom";
import type { SetupStepState, SetupSummary, Tenant } from "../types";
import { Card, fmtDate } from "./ui";

const STATE_TEXT: Record<SetupStepState, string> = { done: "Done", skipped: "Skipped", open: "Open" };

/** "7/9", or Finished: Kom igång progress in the customer list. */
export function SetupCell({ setup, tenantId }: { setup?: SetupSummary | null; tenantId: string }) {
  if (!setup || !setup.total) return <span className="muted" title="Not checked yet">-</span>;
  const label = setup.complete ? "Finished" : `${setup.finished}/${setup.total}`;
  const title = setup.complete
    ? `Kom igång finished${setup.completedAt ? ` ${fmtDate(setup.completedAt)}` : ""}`
    : `${setup.finished} of ${setup.total} Kom igång steps done or skipped`;
  return (
    <Link to={`/tenants/${tenantId}`} className={`cell-link setup-cell${setup.complete ? " ok" : ""}`} title={title} aria-label={title}>
      <span className="ring-text">{label}</span>
    </Link>
  );
}

/**
 * The restaurant's Kom igång in Booqy Admin: each step done, skipped or
 * open (per location where it differs), and when every step was first
 * finished. Written by the application (tenant-setup); read only here.
 */
export function SetupCard({ tenant }: { tenant: Tenant }) {
  const s = tenant.setupState;
  const info = "Kom igång in Booqy Admin. Finished = every step done or skipped at every location; we are notified once, then build the website.";
  if (!s) {
    return (
      <Card title="Setup" info={info}>
        <p className="muted">Not checked yet. It updates within 15 minutes, or when the owner opens Översikt.</p>
      </Card>
    );
  }
  return (
    <Card title="Setup" info={info}>
      <dl className="dl">
        <dt>Done</dt><dd>{s.done}</dd>
        <dt>Skipped</dt><dd>{s.skipped}</dd>
        <dt>Open</dt><dd>{s.open}</dd>
        {/* A step reopened later: the date stays (we were notified then), labelled as the first time. */}
        <dt>{s.complete || !tenant.setupCompletedAt ? "Finished" : "First finished"}</dt>
        <dd>{tenant.setupCompletedAt ? fmtDate(tenant.setupCompletedAt) : <span className="muted">-</span>}</dd>
      </dl>
      <ul className="setup-steps" aria-label="Setup steps">
        {s.steps.map((step) => {
          const mixed = (step.locations?.length ?? 0) > 1 && step.locations!.some((l) => l.state !== step.state);
          return (
            <li key={step.id}>
              <span>
                {step.labelEn}
                {mixed && (
                  <span className="small muted setup-where">
                    {step.locations!.map((l) => `${l.name || l.locationId}: ${STATE_TEXT[l.state].toLowerCase()}`).join(", ")}
                  </span>
                )}
              </span>
              <span className={`setup-state--${step.state}`}>{STATE_TEXT[step.state]}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
