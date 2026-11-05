import { accessToken } from "../../auth";
import { ApiError } from "../../api";
import { withBusy } from "../../busy";

/** Operator routes L15-L18 (CONTRACTS.md 6.L), forwarded by platform-tenants to phone-agent. */

export interface PhoneAgentSettings { killSwitch: boolean; maxMinutesCap: number }
export interface PhoneAgentTenant {
  paused: boolean;
  locations: { locationId: string; enabled: boolean; number: string | null; minutesThisPeriod: number }[];
  usage: { periodEnd: string; minutes: number }[];
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
      const message = res.status === 404 ? "The phone agent is not deployed in this environment, or it is not on for this tenant."
        : res.status === 503 ? "The phone agent did not answer. Try again in a minute."
        : res.status === 400 && code === "invalid_cap" ? "The cap must be a whole number from 0 to 100000."
        : `Request failed (${code}).`;
      throw new ApiError(res.status, code, message, data.fields ?? {});
    }
    return data as T;
  });
}

export const phoneAgentApi = {
  settings: () => call<PhoneAgentSettings>("GET", "/platform/phone-agent/settings"),
  saveSettings: (s: PhoneAgentSettings) => call<PhoneAgentSettings>("PUT", "/platform/phone-agent/settings", s),
  tenant: (tenantId: string) => call<PhoneAgentTenant>("GET", `/platform/tenants/${encodeURIComponent(tenantId)}/phone-agent`),
  setPaused: (tenantId: string, paused: boolean) =>
    call<{ paused: boolean }>("PUT", `/platform/tenants/${encodeURIComponent(tenantId)}/phone-agent`, { paused }),
};
