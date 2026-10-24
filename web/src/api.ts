import { accessToken, notifySignedOut, signOut } from "./auth";
import type {
  BillingView, DnsRecord, DnsScan, DomainOffer, FinanceOverview, FinanceTenantDetail, InvoicingRun, Money, PaymentsView, RegistrantContact, SupportCase, TransferCheck, Zone,
  Location, LocationInput, MailRecipient, MailTemplate, MailTemplateInput, NewTenantInput, Newsletter, NewsletterRecipient, OperatorAccount, OutboxMessage, OutboxSummary, TerminalAddress, ReaderFleet, TerminalReader, TerminalSetup, TerminalState, Plan, Tenant, TenantDetail, TenantSummary, TenantUser,
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

/** What to say when the response has no message of its own (a gateway
 * error page, a crash, a throttle). */
function fallbackMessage(status: number, requestId?: unknown): string {
  const ref = requestId ? ` (reference ${requestId})` : "";
  if (status === 403) return "You don't have access to this. Sign out and in again; if it persists, check that your account is an operator.";
  if (status === 404) return "Not found - it may have been removed. Reload the page.";
  if (status === 429) return "Too many requests right now. Wait a few seconds and try again.";
  if (status > 500) return "The API didn't respond. Try again in a minute; after a save, reload first to see whether it went through.";
  return `Something went wrong on our side${ref}. Try again; if it keeps failing, check the platform-tenants logs${ref ? " for that reference" : ""}.`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  if (res.status === 401) {
    // token rejected (revoked, account disabled/deleted) - back to the login page
    await signOut().catch(() => undefined);
    notifySignedOut();
    throw new ApiError(401, "unauthorized", "Signed out");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new ApiError(res.status, "bad_response", "The API sent an unreadable response. Reload the page and try again.");
  }
  if (!res.ok) {
    const { error, message, fields, ...extra } = data;
    // The generic 500 text says nothing useful - give what to do instead.
    const useful = typeof message === "string" && message && !(res.status >= 500 && error === "internal_error");
    throw new ApiError(res.status, (error as string) ?? "error",
                       useful ? (message as string) : fallbackMessage(res.status, extra.requestId),
                       (fields as Record<string, string>) ?? {}, extra);
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
  setPlan: (id: string, body: { planId: string; overrides?: unknown; force?: boolean; priceSek?: number }) =>
    request<{ tenant: Tenant }>("PUT", `${t(id)}/plan`, body),
  suspend: (id: string, reason: string) => request("POST", `${t(id)}/suspend`, { reason }),
  resume: (id: string) => request("POST", `${t(id)}/resume`, {}),
  offboard: (id: string, confirmSlug: string) => request("POST", `${t(id)}/offboard`, { confirmSlug }),
  purgeNow: (id: string, confirmSlug: string) => request("POST", `${t(id)}/purge`, { confirmSlug }),
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
  searchDomains: (q: string) =>
    request<{ results: DomainOffer[]; suggestions: DomainOffer[] }>("GET", `/platform/domains/search?q=${encodeURIComponent(q)}`),
  scanDns: (domain: string) =>
    request<DnsScan>("GET", `/platform/domains/dns-scan?domain=${encodeURIComponent(domain)}`),
  documentUpload: (id: string) =>
    request<{ documentKey: string; upload: { url: string; fields: Record<string, string> }; maxBytes: number }>(
      "POST", `${t(id)}/domains/documents`, {}),
  registerDomain: (id: string, body: { domain: string; makePrimary: boolean; documentKey?: string;
                                       contact: RegistrantContact; acceptedPrice: Money }) =>
    request<{ zone: Zone; supportCase: SupportCase | null }>("POST", `${t(id)}/domains/registrations`, body),
  connectDomain: (id: string, body: { domain: string; makePrimary: boolean; records: DnsRecord[] }) =>
    request<{ zone: Zone; nameServers: string[]; imported: DnsRecord[]; skipped: { name: string; type: string; reason: string }[] }>(
      "POST", `${t(id)}/domains/connections`, body),
  transferCheck: (id: string, domain: string) =>
    request<TransferCheck>("GET", `${t(id)}/zones/${encodeURIComponent(domain)}/transfer`),
  transferDomain: (id: string, domain: string, body: { authCode: string; contact: RegistrantContact;
                                                       acceptedPrice: Money; documentKey?: string }) =>
    request<{ zone: Zone; supportCase: SupportCase | null }>("POST", `${t(id)}/zones/${encodeURIComponent(domain)}/transfer`, body),
  domainDocument: (id: string, domain: string) =>
    request<{ url: string }>("GET", `${t(id)}/zones/${encodeURIComponent(domain)}/document`),
  stripeLink: (id: string) => request<{ url: string; expiresAt?: string }>("POST", `${t(id)}/stripe/account-link`, {}),
  stripeSync: (id: string) => request("POST", `${t(id)}/stripe/sync`, {}),

  // Subscriptions (Stripe Billing on the platform account) and the Finance page
  billing: (id: string) => request<BillingView>("GET", `${t(id)}/billing`),
  startSubscription: (id: string, body: { collectionMethod: "send_invoice" | "charge_automatically"; startDate?: string;
                                          terms?: "trial" | "subscription"; priceSek?: number }) =>
    request<{ billing: BillingView["billing"] }>("POST", `${t(id)}/billing/subscription`, body),
  updateSubscription: (id: string, action: "cancel" | "cancel_now" | "keep" | "convert" | "use_card" | "set_sms_price",
                       options: { offboardAtEnd?: boolean; smsPriceSek?: number | null } = {}) =>
    request<{ billing: BillingView["billing"] }>("PATCH", `${t(id)}/billing/subscription`, { action, ...options }),
  invoiceNow: (id: string) => request<InvoicingRun>("POST", `${t(id)}/billing/invoice`, {}),
  financeInvoicing: (dryRun: boolean) => request<InvoicingRun>("POST", "/platform/finance/invoicing", { dryRun }),
  cardLink: (id: string) => request<{ url: string; expiresAt?: string }>("POST", `${t(id)}/billing/card-link`, {}),
  financeOverview: (params: { from: string; to: string; includeInactive?: boolean; tenantId?: string | null; locationId?: string | null }) => {
    const q = new URLSearchParams({ from: params.from, to: params.to });
    if (params.includeInactive) q.set("includeInactive", "1");
    if (params.tenantId) q.set("tenantId", params.tenantId);
    if (params.tenantId && params.locationId) q.set("locationId", params.locationId);
    return request<FinanceOverview>("GET", `/platform/finance/overview?${q}`);
  },
  financeTenant: (id: string, params: { from: string; to: string }) =>
    request<FinanceTenantDetail>("GET", `/platform/finance/tenants/${encodeURIComponent(id)}?${new URLSearchParams(params)}`),
  financeRebuild: (from: string, to: string) =>
    request<{ from: string; to: string; status: string }>("POST", "/platform/finance/rebuild", { from, to }),
  financeInvoices: (params: { from: string; to: string; status?: string }) => {
    const q = new URLSearchParams({ from: params.from, to: params.to });
    if (params.status && params.status !== "all") q.set("status", params.status);
    return request<PaymentsView>("GET", `/platform/finance/invoices?${q}`);
  },
  remindInvoice: (id: string, invoiceId: string) =>
    request<{ remindersSent: number }>("POST", `${t(id)}/billing/invoices/${encodeURIComponent(invoiceId)}/remind`, {}),
  financeStripeSync: () =>
    request<{ sync: { tenants: number; subscriptions: number; invoices: number; booked: number; errors: string[] } }>(
      "POST", "/platform/finance/stripe-sync", {}),

  terminal: (id: string, locationId: string) =>
    request<TerminalState>("GET", `${t(id)}/locations/${encodeURIComponent(locationId)}/terminal`),
  enableTerminal: (id: string, locationId: string, body: TerminalAddress & { displayName?: string }) =>
    request<{ terminal: TerminalSetup }>("POST", `${t(id)}/locations/${encodeURIComponent(locationId)}/terminal`, body),
  updateTerminal: (id: string, locationId: string, body: Partial<TerminalAddress> & { displayName?: string }) =>
    request<{ terminal: TerminalSetup }>("PATCH", `${t(id)}/locations/${encodeURIComponent(locationId)}/terminal`, body),
  registerReader: (id: string, locationId: string, registrationCode: string, label: string) =>
    request<{ reader: TerminalReader }>("POST", `${t(id)}/locations/${encodeURIComponent(locationId)}/terminal/readers`,
                                        { registrationCode, label }),
  allReaders: () => request<ReaderFleet>("GET", "/platform/terminal/readers"),
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

  // News to the restaurant owners (Mail page)
  mailTemplate: () => request<{ template: MailTemplate }>("GET", "/platform/mail/template").then((r) => r.template),
  saveMailTemplate: (body: MailTemplateInput) =>
    request<{ template: MailTemplate }>("PUT", "/platform/mail/template", body).then((r) => r.template),
  mailPreview: (body: { subject: string; body: string; template?: Partial<MailTemplateInput> }) =>
    request<{ subject: string; html: string; text: string }>("POST", "/platform/mail/preview", body),
  mailRecipients: () => request<{ count: number; recipients: MailRecipient[] }>("GET", "/platform/mail/recipients"),
  newsletters: () => request<{ newsletters: Newsletter[] }>("GET", "/platform/mail/newsletters").then((r) => r.newsletters),
  newsletter: (id: string) =>
    request<{ newsletter: Newsletter; recipients: NewsletterRecipient[] }>("GET", `/platform/mail/newsletters/${encodeURIComponent(id)}`),
  sendNewsletter: (body: { subject: string; body: string; test?: boolean }) =>
    request<{ test?: boolean; sentTo?: string; newsletter?: Newsletter }>("POST", "/platform/mail/newsletters", body),
};

/** Browser -> S3 straight, with the presigned POST from documentUpload(). */
export async function uploadToS3(upload: { url: string; fields: Record<string, string> }, file: File): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append("file", file);                 // must be the last field
  const res = await fetch(upload.url, { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, "upload_failed", "The upload was refused - is it a PDF under 10 MB?");
}
