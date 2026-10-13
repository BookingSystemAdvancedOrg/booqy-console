import { accessToken, notifySignedOut, signOut } from "./auth";
import type {
  Location, LocationInput, NewTenantInput, OperatorAccount, OutboxMessage, OutboxSummary, TerminalAddress, TerminalReader, TerminalSetup, TerminalState, Plan, Tenant, TenantDetail, TenantSummary, TenantUser,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const BASE = import.meta.env.VITE_API_URL.replace(/\/$/, "");

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // token rejected (revoked, account disabled/deleted) - back to the login page
    await signOut().catch(() => undefined);
    notifySignedOut();
    throw new ApiError(401, "unauthorized", "Signed out");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const { error, message, fields, ...extra } = data;
    throw new ApiError(res.status, error ?? "error", message ?? res.statusText, fields ?? {}, extra);
  }
  return data as T;
}

const t = (id: string) => `/platform/tenants/${encodeURIComponent(id)}`;

export const api = {
  plans: () => request<{ plans: Plan[] }>("GET", "/platform/plans").then((r) => r.plans),
  tenants: () => request<{ tenants: TenantSummary[] }>("GET", "/platform/tenants").then((r) => r.tenants),
  tenant: (id: string) => request<TenantDetail>("GET", t(id)),
  createTenant: (input: NewTenantInput) =>
    request<{ tenantId: string; status: string }>("POST", "/platform/tenants", input),
  updateTenant: (id: string, patch: Record<string, unknown>) =>
    request<{ tenant: Tenant }>("PATCH", t(id), patch),
  setPlan: (id: string, body: { planId: string; overrides?: unknown; force?: boolean }) =>
    request<{ tenant: Tenant }>("PUT", `${t(id)}/plan`, body),
  suspend: (id: string, reason: string) => request("POST", `${t(id)}/suspend`, { reason }),
  resume: (id: string) => request("POST", `${t(id)}/resume`, {}),
  offboard: (id: string, confirmSlug: string) => request("POST", `${t(id)}/offboard`, { confirmSlug }),
  retryOnboarding: (id: string) => request<{ status: string }>("POST", `${t(id)}/onboarding/retry`, {}),
  users: (id: string) => request<{ users: TenantUser[] }>("GET", `${t(id)}/users`).then((r) => r.users),
  inviteOwner: (id: string, email: string, name: string) => request("POST", `${t(id)}/owners`, { email, name }),
  createLocation: (id: string, loc: LocationInput) =>
    request<{ location: Location }>("POST", `${t(id)}/locations`, loc),
  updateLocation: (id: string, locationId: string, patch: Partial<LocationInput>) =>
    request<{ location: Location }>("PATCH", `${t(id)}/locations/${encodeURIComponent(locationId)}`, patch),
  deleteLocation: (id: string, locationId: string) =>
    request("DELETE", `${t(id)}/locations/${encodeURIComponent(locationId)}`),
  addDomain: (id: string, domain: string, makePrimary: boolean) =>
    request<{ domain: string; dns: { type: string; name: string; value: string }[] }>(
      "POST", `${t(id)}/domains`, { domain, makePrimary }),
  removeDomain: (id: string, domain: string) =>
    request("DELETE", `${t(id)}/domains/${encodeURIComponent(domain)}`),
  stripeLink: (id: string) => request<{ url: string; expiresAt?: string }>("POST", `${t(id)}/stripe/account-link`, {}),
  stripeSync: (id: string) => request("POST", `${t(id)}/stripe/sync`, {}),

  terminal: (id: string, locationId: string) =>
    request<TerminalState>("GET", `${t(id)}/locations/${encodeURIComponent(locationId)}/terminal`),
  enableTerminal: (id: string, locationId: string, body: TerminalAddress & { displayName?: string }) =>
    request<{ terminal: TerminalSetup }>("POST", `${t(id)}/locations/${encodeURIComponent(locationId)}/terminal`, body),
  updateTerminal: (id: string, locationId: string, body: Partial<TerminalAddress> & { displayName?: string }) =>
    request<{ terminal: TerminalSetup }>("PATCH", `${t(id)}/locations/${encodeURIComponent(locationId)}/terminal`, body),
  registerReader: (id: string, locationId: string, registrationCode: string, label: string) =>
    request<{ reader: TerminalReader }>("POST", `${t(id)}/locations/${encodeURIComponent(locationId)}/terminal/readers`,
                                        { registrationCode, label }),
  removeReader: (id: string, locationId: string, readerId: string) =>
    request("DELETE", `${t(id)}/locations/${encodeURIComponent(locationId)}/terminal/readers/${encodeURIComponent(readerId)}`),

  operators: () => request<{ operators: OperatorAccount[] }>("GET", "/platform/operators").then((r) => r.operators),
  createOperator: (email: string, name: string) =>
    request<{ operator: OperatorAccount }>("POST", "/platform/operators", { email, name }),
  updateOperator: (username: string, patch: { name?: string; enabled?: boolean }) =>
    request<{ operator: OperatorAccount }>("PATCH", `/platform/operators/${encodeURIComponent(username)}`, patch),
  deleteOperator: (username: string) => request("DELETE", `/platform/operators/${encodeURIComponent(username)}`),
  resendInvite: (username: string) =>
    request("POST", `/platform/operators/${encodeURIComponent(username)}/resend-invite`, {}),

  outbox: (after?: string) =>
    request<{ enabled: boolean; messages: OutboxSummary[]; next?: string | null }>(
      "GET", `/platform/outbox${after ? `?after=${encodeURIComponent(after)}` : ""}`),
  outboxMessage: (messageId: string) =>
    request<{ message: OutboxMessage }>("GET", `/platform/outbox/${encodeURIComponent(messageId)}`).then((r) => r.message),
};
