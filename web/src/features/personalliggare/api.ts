import { accessToken } from "../../auth";
import { ApiError } from "../../api";
import { withBusy } from "../../busy";

/** Operator route H9 (CONTRACTS.md 6.H), forwarded by platform-tenants to personalliggare; audited per call. */

export interface LedgerExport {
  locationId: string;
  from: string;
  to: string;
  format: "csv";
  filename: string;
  count: number;
  chainOk: boolean;
  firstBadSeq?: number;
  content: string;
}

const BASE = import.meta.env.VITE_API_URL.replace(/\/$/, "");

export async function exportLedger(tenantId: string, q: { locationId: string; from: string; to: string }): Promise<LedgerExport> {
  return withBusy(async () => {
    const token = await accessToken();
    const query = new URLSearchParams(q).toString();
    let res: Response;
    try {
      res = await fetch(`${BASE}/platform/tenants/${encodeURIComponent(tenantId)}/personalliggare/export?${query}`,
                        { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      throw new ApiError(0, "network", "Couldn't reach the API. Check your internet connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = (data.error as string) ?? "error";
      const message = res.status === 404 ? "No staff ledger records for this location, or the feature is not deployed in this environment."
        : res.status === 400 ? "Check the dates: from must be on or before to, at most one year."
        : res.status === 503 ? "The staff ledger did not answer. Try again in a minute."
        : `Request failed (${code}).`;
      throw new ApiError(res.status, code, message, data.fields ?? {});
    }
    return data as LedgerExport;
  });
}
