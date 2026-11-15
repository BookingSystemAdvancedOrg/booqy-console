import { useState } from "react";
import { Card, ErrorNotice, Field, Notice, useAction, useLoad } from "../../components/ui";
import { ApiError } from "../../api";
import { phoneAgentApi } from "./api";

/** Settings page: the platform-wide kill switch and the ceiling for every restaurant's monthly minutes cap. */
export default function PhoneAgentSettingsCard() {
  const { data, error, setData } = useLoad(() => phoneAgentApi.settings(), []);
  const action = useAction();
  const [cap, setCap] = useState<string | null>(null);

  // The settings route has no tenant: a 404 means the phone-agent function is not deployed here yet.
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Card title="Phone agent">
        <Notice>The phone agent is not set up in this environment yet. The kill switch and the minutes ceiling appear here once it is deployed.</Notice>
      </Card>
    );
  }
  if (error) return <Card title="Phone agent"><ErrorNotice error={error} /></Card>;
  if (!data) return null;
  const capValue = cap ?? String(data.maxMinutesCap);

  async function save(killSwitch: boolean) {
    const saved = await action.run(() => phoneAgentApi.saveSettings({ killSwitch, maxMinutesCap: Number(capValue) }));
    if (saved) { setData(saved); setCap(null); }
  }

  return (
    <Card title="Phone agent" saved={action.done}>
      {data.killSwitch && (
        <Notice kind="warn">The kill switch is ON: the phone agent answers no restaurant's calls; callers hear that bookings by phone are not possible right now.</Notice>
      )}
      <Field label="Max minutes per restaurant per month" hint="Owners can set their own cap up to this ceiling (0-100000)."
             error={action.fields.maxMinutesCap}>
        <input type="number" min={0} max={100000} value={capValue} onChange={(e) => setCap(e.target.value)} />
      </Field>
      <ErrorNotice error={action.error} />
      <div className="row">
        <button className="btn" disabled={action.busy || cap === null} onClick={() => void save(data.killSwitch)}>Save ceiling</button>
        <button className={`btn ${data.killSwitch ? "" : "btn--danger"}`} disabled={action.busy}
                onClick={() => void save(!data.killSwitch)}>
          {data.killSwitch ? "Turn kill switch off" : "Turn kill switch on (stop all calls)"}
        </button>
      </div>
    </Card>
  );
}
