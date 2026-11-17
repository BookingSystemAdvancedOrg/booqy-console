import { useState } from "react";
import { Card, ErrorNotice, Field, Notice, useAction, useLoad } from "../../components/ui";
import { ApiError } from "../../api";
import { SkelCard, SkelPage } from "../../components/Skeleton";
import { CAP_RANGE, phoneAgentApi } from "./api";

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
  if (!data) return <SkelPage label="Loading the phone agent"><SkelCard lines={3} /></SkelPage>;
  const capValue = cap ?? String(data.maxMinutesCap);

  // The kill switch is an emergency stop: it sends the saved ceiling, so an unsaved or invalid cap in the field never blocks
  // it (and the field keeps what was typed). Only Save ceiling sends the field.
  async function save(killSwitch: boolean, ceiling: number, fromField = false) {
    const saved = await action.run(() => phoneAgentApi.saveSettings({ killSwitch, maxMinutesCap: ceiling }));
    if (saved) { setData(saved); if (fromField) setCap(null); }
  }
  // useAction words field messages plainly; the raw code says which range to show.
  const capError = action.error instanceof ApiError && action.error.fields?.maxMinutesCap === "invalid_cap" ? CAP_RANGE : action.fields.maxMinutesCap;

  return (
    <Card title="Phone agent" saved={action.done} info={<>Owners can set their own cap up to this ceiling (0-100000).</>}>
      {data.killSwitch && (
        <Notice kind="warn">The kill switch is ON: the phone agent answers no restaurant's calls; callers hear that bookings by phone are not possible right now.</Notice>
      )}
      <Field label="Max minutes per restaurant per month"
             error={capError}>
        <input className="input mono" style={{ width: 160 }} type="number" inputMode="numeric" min={0} max={100000} step={1}
               value={capValue} onChange={(e) => setCap(e.target.value)} />
      </Field>
      <ErrorNotice error={action.error && !Object.keys(action.fields).length ? action.error : null} />
      <div className="row">
        <button className="btn" disabled={action.busy || cap === null} onClick={() => void save(data.killSwitch, Number(capValue), true)}>Save ceiling</button>
        <button className={`btn ${data.killSwitch ? "" : "btn--danger"}`} disabled={action.busy}
                onClick={() => void save(!data.killSwitch, data.maxMinutesCap)}>
          {data.killSwitch ? "Turn kill switch off" : "Turn kill switch on (stop all calls)"}
        </button>
      </div>
    </Card>
  );
}
