import { useState } from "react";
import { Card, ErrorNotice, Field, Notice, useAction, useLoad } from "../../components/ui";
import { ApiError } from "../../api";
import { SaveBar, useDirty } from "../../components/save";
import { SkelCard, SkelPage } from "../../components/Skeleton";
import { CAP_RANGE, metaAdsApi } from "./api";

/** Settings page: the platform kill switch and the ceiling for every restaurant's monthly cap. */
export default function MetaAdsSettingsCard() {
  const { data, error, setData } = useLoad(() => metaAdsApi.settings(), []);
  const action = useAction();
  const [cap, setCap] = useState<string | null>(null);
  const savedCap = data ? String(data.maxMonthlyCapSek) : "";
  const dirty = useDirty(cap ?? savedCap, savedCap);

  // The platform settings route has no tenant, so a 404 can only mean the meta-ads function is not deployed here yet.
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Card title="Meta ads">
        <Notice>Meta ads is not set up in this environment yet. The kill switch and the cap ceiling appear here once it is deployed.</Notice>
      </Card>
    );
  }
  if (error) return <Card title="Meta ads"><ErrorNotice error={error} /></Card>;
  if (!data) return <SkelPage label="Loading Meta ads"><SkelCard lines={3} /></SkelPage>;
  const capValue = cap ?? savedCap;

  // The kill switch is an emergency stop: it sends the saved ceiling, so an unsaved or invalid cap in the field never blocks
  // it (and the field keeps what was typed). Only Save ceiling sends the field.
  async function save(killSwitch: boolean, ceiling: number, fromField = false) {
    const saved = await action.run(() => metaAdsApi.saveSettings({ killSwitch, maxMonthlyCapSek: ceiling }));
    if (saved) { setData(saved); if (fromField) setCap(null); }
  }
  // useAction words field messages plainly; the raw code says which range to show.
  const capError = action.error instanceof ApiError && action.error.fields?.maxMonthlyCapSek === "invalid_cap" ? CAP_RANGE : action.fields.maxMonthlyCapSek;

  return (
    <Card title="Meta ads" saved={action.done} info={<>Owners can set their own cap up to this ceiling. {CAP_RANGE}</>}>
      {data.killSwitch && (
        <Notice kind="warn">The kill switch is ON: no restaurant can create or start ads, and running ads are paused within 15 minutes.</Notice>
      )}
      <Field label="Max monthly cap per restaurant (SEK)"
             error={capError}>
        <input className="input mono" style={{ width: 160 }} type="number" inputMode="numeric" min={100} max={1000000} step={1}
               value={capValue} onChange={(e) => setCap(e.target.value)} />
      </Field>
      <ErrorNotice error={action.error && !Object.keys(action.fields).length ? action.error : null} />
      <SaveBar label="Save ceiling" dirty={dirty.dirty} busy={action.busy} failed={dirty.dirty && !!action.error}
               onSave={() => void save(data.killSwitch, Number(capValue), true)} onDiscard={() => { setCap(null); action.setError(null); }} />
      <div className="row">
        <button className={`btn ${data.killSwitch ? "btn--ghost" : "btn--danger"}`} disabled={action.busy}
                onClick={() => void save(!data.killSwitch, data.maxMonthlyCapSek)}>
          {data.killSwitch ? "Turn kill switch off" : "Turn kill switch on (pause all ads)"}
        </button>
      </div>
    </Card>
  );
}
