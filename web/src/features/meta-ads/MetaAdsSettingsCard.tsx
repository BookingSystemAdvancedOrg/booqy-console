import { useState } from "react";
import { Card, ErrorNotice, Field, Notice, useAction, useLoad } from "../../components/ui";
import { ApiError } from "../../api";
import { metaAdsApi } from "./api";

/** Settings page: the platform kill switch and the ceiling for every restaurant's monthly cap. */
export default function MetaAdsSettingsCard() {
  const { data, error, setData } = useLoad(() => metaAdsApi.settings(), []);
  const action = useAction();
  const [cap, setCap] = useState<string | null>(null);

  // The platform settings route has no tenant, so a 404 can only mean the meta-ads function is not deployed here yet.
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Card title="Meta ads">
        <Notice>Meta ads is not set up in this environment yet. The kill switch and the cap ceiling appear here once it is deployed.</Notice>
      </Card>
    );
  }
  if (error) return <Card title="Meta ads"><ErrorNotice error={error} /></Card>;
  if (!data) return null;
  const capValue = cap ?? String(data.maxMonthlyCapSek);

  async function save(killSwitch: boolean) {
    const saved = await action.run(() => metaAdsApi.saveSettings({ killSwitch, maxMonthlyCapSek: Number(capValue) }));
    if (saved) { setData(saved); setCap(null); }
  }

  return (
    <Card title="Meta ads" saved={action.done}>
      {data.killSwitch && (
        <Notice kind="warn">The kill switch is ON: no restaurant can create or start ads, and running ads are paused within 15 minutes.</Notice>
      )}
      <Field label="Max monthly cap per restaurant (SEK)" hint="Owners can set their own cap up to this ceiling."
             error={action.fields.maxMonthlyCapSek}>
        <input type="number" min={100} value={capValue} onChange={(e) => setCap(e.target.value)} />
      </Field>
      <ErrorNotice error={action.error} />
      <div className="row">
        <button className="btn" disabled={action.busy || cap === null} onClick={() => void save(data.killSwitch)}>Save ceiling</button>
        <button className={`btn ${data.killSwitch ? "" : "btn--danger"}`} disabled={action.busy}
                onClick={() => void save(!data.killSwitch)}>
          {data.killSwitch ? "Turn kill switch off" : "Turn kill switch on (pause all ads)"}
        </button>
      </div>
    </Card>
  );
}
