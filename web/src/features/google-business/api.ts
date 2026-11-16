import { request, type ErrorMessages } from "../../api";

/** Operator route D11 (CONTRACTS.md 6.D), forwarded by platform-tenants to google-business. */

export interface GoogleBusinessLink { locationId: string; title: string; syncStatus: "pending" | "ok" | "error"; lastSyncAt: string | null }
export interface GoogleBusinessTenant { status: "connected" | "needs_reauth" | "disconnected"; links: GoogleBusinessLink[] }

const messages: ErrorMessages = (status) =>
  status === 404 ? "Google Business Profile is not deployed in this environment, or the tenant is unknown."
  : status === 503 ? "The Google Business Profile feature did not answer. Try again in a minute."
  : undefined;

/** Through api.ts: busy bar, quiet live refetch, 401 refresh and request id, as every call. */
function call<T>(path: string): Promise<T> {
  return request<T>("GET", path, undefined, { messages });
}

export const googleBusinessApi = {
  tenant: (tenantId: string) => call<GoogleBusinessTenant>(`/platform/tenants/${encodeURIComponent(tenantId)}/google-business`),
};
