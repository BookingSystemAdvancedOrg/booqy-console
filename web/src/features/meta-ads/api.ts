import { accessToken } from "../../auth";
import { ApiError } from "../../api";
import { withBusy } from "../../busy";

/** Operator routes A14-A17 (CONTRACTS.md 6.A), forwarded by platform-tenants to meta-ads. */

export interface MetaAdsSettings { killSwitch: boolean; maxMonthlyCapSek: number }
export interface MetaAdsTenant {
  status: "connected" | "needs_reauth" | "disconnected";
  adAccountId?: string;
  pageId?: string;
  instagramId?: string;
  paused: boolean;
  spendThisMonthSek: number;
}

const BASE = import.meta.env.VITE_API_URL.replace(/\/$/, "");

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return withBusy(async () => {
    const token = await accessToken();
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, "network", "Couldn't reach the API. Check your internet connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = (data.error as string) ?? "error";
      const message = res.status === 404 ? "Meta ads is not deployed in this environment, or the tenant is unknown."
        : res.status === 503 ? "The Meta ads feature did not answer. Try again in a minute."
        : typeof data.message === "string" ? data.message : `Request failed (${code}).`;
      throw new ApiError(res.status, code, message, data.fields ?? {});
    }
    return data as T;
  });
}

export const metaAdsApi = {
  settings: () => call<MetaAdsSettings>("GET", "/platform/meta-ads/settings"),
  saveSettings: (s: MetaAdsSettings) => call<MetaAdsSettings>("PUT", "/platform/meta-ads/settings", s),
  tenant: (tenantId: string) => call<MetaAdsTenant>("GET", `/platform/tenants/${encodeURIComponent(tenantId)}/meta-ads`),
  setPaused: (tenantId: string, paused: boolean) =>
    call<{ paused: boolean }>("PUT", `/platform/tenants/${encodeURIComponent(tenantId)}/meta-ads`, { paused }),
};
