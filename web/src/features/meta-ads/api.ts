import { request, type ErrorMessages } from "../../api";

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

/** The cap range the server accepts (meta_ads MIN_BUDGET_SEK..1 000 000). */
export const CAP_RANGE = "Use whole kronor from 100 to 1 000 000, like 5000.";

const messages: ErrorMessages = (status, code) =>
  status === 404 ? "Meta ads isn't switched on here, or we can't find this customer."
  : status === 503 ? "Meta ads didn't answer. Try again in a minute."
  : status === 400 && code === "invalid_cap" ? CAP_RANGE
  : undefined;

/** Through api.ts: busy bar, quiet live refetch, 401 refresh, request id and the refetch after a save, as every call. */
function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body, { messages });
}

export const metaAdsApi = {
  settings: () => call<MetaAdsSettings>("GET", "/platform/meta-ads/settings"),
  saveSettings: (s: MetaAdsSettings) => call<MetaAdsSettings>("PUT", "/platform/meta-ads/settings", s),
  tenant: (tenantId: string) => call<MetaAdsTenant>("GET", `/platform/tenants/${encodeURIComponent(tenantId)}/meta-ads`),
  setPaused: (tenantId: string, paused: boolean) =>
    call<{ paused: boolean }>("PUT", `/platform/tenants/${encodeURIComponent(tenantId)}/meta-ads`, { paused }),
};
