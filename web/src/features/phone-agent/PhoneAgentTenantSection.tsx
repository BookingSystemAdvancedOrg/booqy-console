import { Fragment } from "react";
import { Card, ErrorNotice, Notice, useAction, useLoad } from "../../components/ui";
import { ApiError } from "../../api";
import { phoneAgentApi } from "./api";

/** Tenant > Integrations: the restaurant's phone agent numbers, minutes per billing period and the operator pause. */
export default function PhoneAgentTenantSection({ tenantId }: { tenantId: string }) {
  const { data, error, setData } = useLoad(() => phoneAgentApi.tenant(tenantId), [tenantId]);
  const action = useAction();

  if (error instanceof ApiError && error.status === 404) {
    return <Card title="Phone agent"><p className="muted">The phone agent is not set up in this environment, or it has never been on for this tenant.</p></Card>;
  }
  if (error) return <Card title="Phone agent"><ErrorNotice error={error} /></Card>;
  if (!data) return null;
  if (!data.paused && data.locations.length === 0 && data.usage.length === 0) {
    return (
      <Card title="Phone agent">
        <dl className="dl"><dt>Status</dt><dd>Not connected</dd></dl>
        <p className="muted">No location has set up the phone agent yet.</p>
      </Card>
    );
  }

  async function toggle() {
    if (!data) return;
    const out = await action.run(() => phoneAgentApi.setPaused(tenantId, !data.paused));
    if (out) setData({ ...data, paused: out.paused });
  }

  return (
    <Card title="Phone agent" saved={action.done}>
      {data.paused && <Notice kind="warn">Paused by an operator: this restaurant's calls are not answered by the agent.</Notice>}
      {data.locations.length === 0 ? <p className="muted">No locations.</p> : (
        <table className="table">
          <thead><tr><th scope="col">Location</th><th scope="col">Agent</th><th scope="col">Booqy number</th><th scope="col">Minutes this period</th></tr></thead>
          <tbody>
            {data.locations.map((l) => (
              <tr key={l.locationId}>
                <td>{l.locationId}</td>
                <td>{l.enabled ? "On" : "Off"}</td>
                <td className="mono">{l.number ?? "-"}</td>
                <td>{l.minutesThisPeriod.toLocaleString("en-GB")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.usage.length > 0 && (
        <>
          <h3>Minutes per billing period</h3>
          <dl className="dl">
            {data.usage.map((u) => (
              <Fragment key={u.periodEnd}>
                <dt>Until {u.periodEnd}</dt><dd>{u.minutes.toLocaleString("en-GB")}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      )}
      <ErrorNotice error={action.error} />
      <button className={`btn ${data.paused ? "" : "btn--danger"}`} disabled={action.busy} onClick={() => void toggle()}>
        {data.paused ? "Resume phone agent" : "Pause phone agent"}
      </button>
    </Card>
  );
}
