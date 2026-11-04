import { accessToken } from "../../auth";
import { ApiError } from "../../api";
import { withBusy } from "../../busy";

/** Operator route D11 (CONTRACTS.md 6.D), forwarded by platform-tenants to google-business. */

export interface GoogleBusinessLink { locationId: string; title: string; syncStatus: "pending" | "ok" | "error"; lastSyncAt: string | null }
export interface GoogleBusinessTenant { status: "connected" | "needs_reauth" | "disconnected"; links: GoogleBusinessLink[] }

const BASE = import.meta.env.VITE_API_URL.replace(/\/$/, "");

async function call<T>(path: string): Promise<T> {
  return withBusy(async () => {
    const token = await accessToken();
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      throw new ApiError(0, "network", "Couldn't reach the API. Check your internet connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = (data.error as string) ?? "error";
      const message = res.status === 404 ? "Google Business Profile is not deployed in this environment, or the tenant is unknown."
        : res.status === 503 ? "The Google Business Profile feature did not answer. Try again in a minute."
        : `Request failed (${code}).`;
      throw new ApiError(res.status, code, message, data.fields ?? {});
    }
    return data as T;
  });
}

export const googleBusinessApi = {
  tenant: (tenantId: string) => call<GoogleBusinessTenant>(`/platform/tenants/${encodeURIComponent(tenantId)}/google-business`),
};
