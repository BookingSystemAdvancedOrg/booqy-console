import { request, type ErrorMessages } from "../../api";

/** Operator routes L15-L18 (CONTRACTS.md 6.L), forwarded by platform-tenants to phone-agent. */

export interface PhoneAgentSettings { killSwitch: boolean; maxMinutesCap: number }
export interface PhoneAgentTenant {
  paused: boolean;
  locations: { locationId: string; enabled: boolean; number: string | null; minutesThisPeriod: number }[];
  usage: { periodEnd: string; minutes: number }[];
}

/** The minutes cap range the server accepts. */
export const CAP_RANGE = "Use whole minutes from 0 to 100000, like 600.";

const messages: ErrorMessages = (status, code) =>
  status === 404 ? "The phone agent isn't switched on here, or not for this customer."
  : status === 503 ? "The phone agent didn't answer. Try again in a minute."
  : status === 400 && code === "invalid_cap" ? CAP_RANGE
  : undefined;

/** Through api.ts: busy bar, quiet live refetch, 401 refresh, request id and the refetch after a save, as every call. */
function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body, { messages });
}

export const phoneAgentApi = {
  settings: () => call<PhoneAgentSettings>("GET", "/platform/phone-agent/settings"),
  saveSettings: (s: PhoneAgentSettings) => call<PhoneAgentSettings>("PUT", "/platform/phone-agent/settings", s),
  tenant: (tenantId: string) => call<PhoneAgentTenant>("GET", `/platform/tenants/${encodeURIComponent(tenantId)}/phone-agent`),
  setPaused: (tenantId: string, paused: boolean) =>
    call<{ paused: boolean }>("PUT", `/platform/tenants/${encodeURIComponent(tenantId)}/phone-agent`, { paused }),
};
