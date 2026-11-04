import { Card, ErrorNotice, useLoad } from "../../components/ui";
import { ApiError } from "../../api";
import { googleBusinessApi } from "./api";

const STATUS: Record<string, string> = { connected: "Connected", needs_reauth: "Needs to log in again", disconnected: "Not connected" };
const SYNC: Record<string, string> = { ok: "In sync", pending: "Waiting for the first sync", error: "Last sync failed" };

/** Tenant > Integrations: the restaurant's Google Business Profile connection and hours sync per location. */
export default function GoogleBusinessTenantSection({ tenantId }: { tenantId: string }) {
  const { data, error } = useLoad(() => googleBusinessApi.tenant(tenantId), [tenantId]);

  if (error instanceof ApiError && error.status === 404) {
    return <Card title="Google Business Profile"><p className="muted">Google Business Profile is not set up in this environment yet.</p></Card>;
  }
  if (error) return <Card title="Google Business Profile"><ErrorNotice error={error} /></Card>;
  if (!data) return null;

  return (
    <Card title="Google Business Profile">
      <dl className="dl">
        <dt>Status</dt><dd>{STATUS[data.status] ?? data.status}</dd>
      </dl>
      {data.links.length === 0 ? <p className="muted">No location is linked to a Google location.</p> : (
        <table className="table">
          <thead><tr><th scope="col">Location</th><th scope="col">Google location</th><th scope="col">Hours</th><th scope="col">Last sync</th></tr></thead>
          <tbody>
            {data.links.map((l) => (
              <tr key={l.locationId}>
                <td>{l.locationId}</td>
                <td>{l.title}</td>
                <td>{SYNC[l.syncStatus] ?? l.syncStatus}</td>
                <td>{l.lastSyncAt ? new Date(l.lastSyncAt).toLocaleString("en-GB") : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
