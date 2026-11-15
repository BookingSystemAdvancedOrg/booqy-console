import { Card, ErrorNotice, Notice, useAction, useLoad } from "../../components/ui";
import { metaAdsApi } from "./api";

const STATUS: Record<string, string> = { connected: "Connected", needs_reauth: "Needs to log in again", disconnected: "Not connected" };

/** Tenant > Integrations: the restaurant's Meta connection and the per-tenant pause. */
export default function MetaAdsTenantSection({ tenantId }: { tenantId: string }) {
  const { data, error, setData } = useLoad(() => metaAdsApi.tenant(tenantId), [tenantId]);
  const action = useAction();

  if (error) return <Card title="Meta ads"><ErrorNotice error={error} /></Card>;
  if (!data) return null;

  async function toggle() {
    if (!data) return;
    const out = await action.run(() => metaAdsApi.setPaused(tenantId, !data.paused));
    if (out) setData({ ...data, paused: out.paused });
  }

  return (
    <Card title="Meta ads" saved={action.done}>
      {data.paused && <Notice kind="warn">Paused by an operator: this restaurant cannot create or start ads.</Notice>}
      <dl className="dl">
        <dt>Status</dt><dd>{STATUS[data.status] ?? data.status}</dd>
        <dt>Ad account</dt><dd>{data.adAccountId ?? "-"}</dd>
        <dt>Facebook page</dt><dd>{data.pageId ?? "-"}</dd>
        <dt>Instagram</dt><dd>{data.instagramId ?? "-"}</dd>
        <dt>Spend this month</dt><dd>{data.spendThisMonthSek.toLocaleString("en-GB")} SEK</dd>
      </dl>
      <ErrorNotice error={action.error} />
      {/* Nothing to pause before Meta is connected; a pause set earlier can still be lifted. */}
      {(data.paused || data.status !== "disconnected") && <button className={`btn ${data.paused ? "" : "btn--danger"}`} disabled={action.busy} onClick={() => void toggle()}>
        {data.paused ? "Resume Meta ads" : "Pause Meta ads"}
      </button>}
    </Card>
  );
}
