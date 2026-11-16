import { AuthUnavailableError, accessToken, notifySignedOut, refreshedAccessToken, signOut } from "./auth";
import { withBusy } from "./busy";
import { isQuiet, notifySaved } from "./live";
import type { WebsiteOverview } from "./website";
import type { HelpAnswer } from "./features/help/kb";
import type {
  BillingView, DnsRecord, FreeInput, DnsScan, DomainOffer, FinanceOverview, FinanceTenantDetail, InvoicingRun, Money, PaymentsView, RegistrantContact, SimulateEvent, SiteStatus, SupportCase, SupportReport, TransferCheck, TransferInCheck, Zone,
  Location, LocationInput, MailRecipient, MailTemplate, MailTemplateInput, NewTenantInput, Newsletter, NewsletterRecipient, OperatorAccount, OperatorList, OutboxMessage, OutboxSummary, Plan, Tenant, TenantDetail, TenantSummary, TenantUser,
} from "./types";

export type BackdropItem = { id: string; url: string; thumbUrl: string; uploadedAt: string; width: number; height: number };

export class ApiError extends Error {
  /** The API's own message when it had a useful one (errors.ts builds the who-acts text from it). */
  serverMessage?: string;

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
 * error page, a crash, a throttle): who acts, as in errors.ts. */
function fallbackMessage(status: number, requestId?: unknown): string {
  const ref = requestId ? ` (request ${requestId})` : "";
  if (status === 403) return "Your account isn't allowed to do this. Sign out and in again; if it persists, another operator checks your account under Operators.";
  if (status === 404) return "Not found: it may have been removed elsewhere. The page shows what is left by itself.";
  if (status === 429) return "Too many requests right now. Wait a few seconds and try again.";
  return `Something failed on Booqy's side${ref}. This is a Booqy fault (a bug or an outage), not something you did. Try again; if it keeps failing, copy the details and look the request up in the logs.`;
}

/** API Gateway's request id: the body's (platform-tenants puts it in 500s), else the header when it is readable. */
function requestIdOf(res: Response, extra: Record<string, unknown>): string | undefined {
  const raw = typeof extra.requestId === "string" ? extra.requestId : res.headers?.get?.("apigw-requestid");
  return raw && /^[A-Za-z0-9=_.:-]{1,100}$/.test(raw) ? raw : undefined;
}

/** quiet: no busy bar and no "data changed" signal (a read-only POST with its own animation, as the help assistant's). signal: abort the call. */
type RequestOptions = { quiet?: boolean; signal?: AbortSignal };

// Every call shows the busy bar (busy.ts), so no load is ever silent; only
// the quiet live refetches (live.ts quietly) and opts.quiet skip it. After a
// write, every live page refetches at once (also after a 409: someone saved
// in between).
function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  if (opts.quiet || (isQuiet() && method === "GET")) return send<T>(method, path, body, opts.signal);
  const call = withBusy(() => send<T>(method, path, body, opts.signal));
  if (method === "GET") return call;
  return call.then(
    (value) => {
      notifySaved({ path });
      return value;
    },
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 409) notifySaved({ path, conflict: true });
      throw err;
    },
  );
}

async function send<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const offline = () => new ApiError(0, "network", "Couldn't reach the API. Check your internet connection and try again.");
  const call = async (token: string) => {
    try {
      return await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch {
      if (signal?.aborted) throw new ApiError(0, "timeout", "The API took too long to answer.");
      throw offline();
    }
  };
  // Cognito unreachable while refreshing the token: a network error, never signed out.
  const orOffline = async <R>(get: () => Promise<R>) => {
    try {
      return await get();
    } catch (err) {
      throw err instanceof AuthUnavailableError ? offline() : err;
    }
  };
  let res = await call(await orOffline(accessToken));
  if (res.status === 401) {
    // One rejected token is not a sign-out: refresh once and try again.
    const fresh = await orOffline(refreshedAccessToken);
    if (fresh) res = await call(fresh);
    if (!fresh || res.status === 401) {
      // token rejected (revoked, account disabled/deleted) - back to the login page
      await signOut().catch(() => undefined);
      notifySignedOut();
      throw new ApiError(401, "unauthorized", "Signed out");
    }
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new ApiError(res.status, "bad_response", "The API sent an unreadable response. This is a Booqy fault, not something you did. Try again; if it keeps failing, look the request up in the logs.");
  }
  if (!res.ok) {
    const { error, message, fields, ...extra } = data;
    const requestId = requestIdOf(res, extra);
    if (requestId) extra.requestId = requestId;
    // The generic 500 text says nothing useful - give what to do instead.
    const useful = typeof message === "string" && message && !(res.status >= 500 && error === "internal_error");
    const err = new ApiError(res.status, typeof error === "string" && error ? error : res.status >= 500 ? "internal_error" : "error",
                             useful ? (message as string) : fallbackMessage(res.status, requestId),
                             (fields as Record<string, string>) ?? {}, extra);
    if (useful) err.serverMessage = message as string;
    throw err;
  }
  return data as T;
}

const t = (id: string) => `/platform/tenants/${encodeURIComponent(id)}`;
const z = (id: string, domain: string) => `${t(id)}/zones/${encodeURIComponent(domain)}`;

export const api = {
  plans: () => request<{ plans: Plan[] }>("GET", "/platform/plans").then((r) => r.plans),
  tenants: () => request<{ tenants: TenantSummary[] }>("GET", "/platform/tenants").then((r) => r.tenants),
  tenant: (id: string) => request<TenantDetail>("GET", t(id)),
  createTenant: (input: NewTenantInput) =>
    request<{ tenantId: string; status: string }>("POST", "/platform/tenants", input),
  updateTenant: (id: string, patch: Record<string, unknown>) =>
    request<{ tenant: Tenant }>("PATCH", t(id), patch),
  setPlan: (id: string, body: { planId: string; overrides?: unknown; force?: boolean; priceSek?: number; free?: FreeInput }) =>
    request<{ tenant: Tenant }>("PUT", `${t(id)}/plan`, body),
  suspend: (id: string, reason: string) => request("POST", `${t(id)}/suspend`, { reason }),
  resume: (id: string) => request("POST", `${t(id)}/resume`, {}),
  offboard: (id: string, confirmSlug: string) => request("POST", `${t(id)}/offboard`, { confirmSlug }),
  purgeNow: (id: string, confirmSlug: string) =>
    request<{ purgeAt: string; repoError?: string }>("POST", `${t(id)}/purge`, { confirmSlug }),
  restore: (id: string) =>
    request<{ usersEnabled: number; failed: string[]; onboardingError?: string }>("POST", `${t(id)}/restore`, {}),
  retryOnboarding: (id: string) => request<{ status: string }>("POST", `${t(id)}/onboarding/retry`, {}),
  // Website tab: the restaurant's own site repo (site-repo function)
  site: (id: string) => request<SiteStatus | { enabled: false }>("GET", `${t(id)}/site`),
  retrySite: (id: string) => request<{ status: string }>("POST", `${t(id)}/site/retry`, {}),
  inviteToSite: (id: string, username: string) =>
    request<{ repo: string; username: string; result: string }>("POST", `${t(id)}/site/invite`, { username }),
  redeploySite: (id: string, branch?: "dev" | "main") =>
    request<{ repo: string; branch: string }>("POST", `${t(id)}/site/redeploy`, branch ? { branch } : {}),
  mountSiteDomain: (id: string, environment: "dev" | "prod") =>
    request<{ hosting: SiteStatus["hosting"] }>("POST", `${t(id)}/site/mount`, { environment }),
  archiveSite: (id: string, confirmSlug: string) =>
    request<{ repo: string; repoArchived: boolean }>("POST", `${t(id)}/site/archive`, { confirmSlug }),
  users: (id: string) => request<{ users: TenantUser[] }>("GET", `${t(id)}/users`).then((r) => r.users),
  inviteOwner: (id: string, email: string, name: string) => request("POST", `${t(id)}/owners`, { email, name }),
  createLocation: (id: string, loc: LocationInput) =>
    request<{ location: Location }>("POST", `${t(id)}/locations`, loc),
  updateLocation: (id: string, locationId: string, patch: Partial<LocationInput>) =>
    request<{ location: Location }>("PATCH", `${t(id)}/locations/${encodeURIComponent(locationId)}`, patch),
  deleteLocation: (id: string, locationId: string) =>
    request("DELETE", `${t(id)}/locations/${encodeURIComponent(locationId)}`),
  addDomain: (id: string, domain: string, makePrimary: boolean) =>
    request<{ domain: string; dns?: { type: string; name: string; value: string }[];
              test?: boolean; hosts?: { stage: "main" | "dev"; host: string }[] }>(
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
  // Own domains: move to Booqy, keep the registrar (DNS records), the order's actions
  transferInCheck: (domain: string) =>
    request<TransferInCheck>("GET", `/platform/domains/transfer-check?domain=${encodeURIComponent(domain)}`),
  transferIn: (id: string, body: { domain: string; authCode: string; records: DnsRecord[]; contact: RegistrantContact;
                                   acceptedPrice: Money; documentKey?: string }) =>
    request<{ zone: Zone; supportCase: SupportCase | null; nameServers: string[] }>("POST", `${t(id)}/domains/transfers`, body),
  recordsDomain: (id: string, domain: string) =>
    request<{ zone: Zone }>("POST", `${t(id)}/domains/records`, { domain }),
  checkZone: (id: string, domain: string) =>
    request<{ result: string; zone: Zone }>("POST", `${z(id, domain)}/check`, {}),
  retryZone: (id: string, domain: string) =>
    request<{ zone: Zone }>("POST", `${z(id, domain)}/retry`, {}),
  notifyZone: (id: string, domain: string) =>
    request<{ sentTo: string }>("POST", `${z(id, domain)}/notify`, {}),
  removeZone: (id: string, domain: string) =>
    request<{ zone: Zone; detached: string[] }>("DELETE", `${z(id, domain)}`),
  zoneAuthCode: (id: string, domain: string, send: boolean) =>
    request<{ authCode?: string; sentTo?: string }>("POST", `${z(id, domain)}/auth-code`, { send }),
  simulateZone: (id: string, domain: string, event: SimulateEvent) =>
    request<{ result: string; zone: Zone }>("POST", `${z(id, domain)}/simulate`, { event }),
  stripeLink: (id: string) => request<{ url: string; expiresAt?: string }>("POST", `${t(id)}/stripe/account-link`, {}),
  stripeSync: (id: string) => request("POST", `${t(id)}/stripe/sync`, {}),

  // Subscriptions (Stripe Billing on the platform account) and the Finance page
  billing: (id: string) => request<BillingView>("GET", `${t(id)}/billing`),
  startSubscription: (id: string, body: { collectionPreference: "card" | "invoice"; startDate?: string;
                                          terms?: "trial" | "subscription"; priceSek?: number }) =>
    request<{ billing: BillingView["billing"] }>("POST", `${t(id)}/billing/subscription`, body),
  updateSubscription: (id: string, action: "cancel" | "cancel_now" | "keep" | "convert" | "use_card" | "collection",
                       options: { offboardAtEnd?: boolean; collectionPreference?: "card" | "invoice" } = {}) =>
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
  website: (params: { from: string; to: string }) =>
    request<WebsiteOverview>("GET", `/platform/website?${new URLSearchParams(params)}`),
  financeStripeSync: () =>
    request<{ sync: { tenants: number; subscriptions: number; invoices: number; booked: number; errors: string[] } }>(
      "POST", "/platform/finance/stripe-sync", {}),

  operators: () => request<OperatorList>("GET", "/platform/operators")
    .then((r) => ({ operators: r.operators, canChangeEmail: r.canChangeEmail === true })),
  // Your profile picture (avatar.ts): only your own can be changed.
  myAvatar: () => request<{ url: string | null }>("GET", "/platform/me/avatar"),
  avatarUpload: (body: { contentType: string; size: number }) =>
    request<{ url: string; fields: Record<string, string> }>("POST", "/platform/me/avatar/upload", body),
  avatarComplete: () => request<{ url: string }>("POST", "/platform/me/avatar/complete"),
  deleteAvatar: () => request<unknown>("DELETE", "/platform/me/avatar"),
  createOperator: (email: string, name: string) =>
    request<{ operator: OperatorAccount }>("POST", "/platform/operators", { email, name }),
  updateOperator: (username: string, patch: { name?: string; email?: string; enabled?: boolean }) =>
    request<{ operator: OperatorAccount }>("PATCH", `/platform/operators/${encodeURIComponent(username)}`, patch),
  deleteOperator: (username: string) => request("DELETE", `/platform/operators/${encodeURIComponent(username)}`),
  resendInvite: (username: string) =>
    request("POST", `/platform/operators/${encodeURIComponent(username)}/resend-invite`, {}),

  outbox: (after?: string) =>
    request<{ enabled: boolean; messages: OutboxSummary[]; next?: string | null }>(
      "GET", `/platform/outbox${after ? `?after=${encodeURIComponent(after)}` : ""}`),
  // Error reports from Booqy Admin ("Rapportera till Booqy"), newest first.
  supportReports: (status: "all" | "open" | "handled" = "all", cursor?: string | null) =>
    request<{ items: SupportReport[]; cursor: string | null }>(
      "GET", `/platform/support/reports?status=${status}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  markReport: (reportId: string, handled: boolean) =>
    request<SupportReport>("POST", `/platform/support/reports/${encodeURIComponent(reportId)}/handled`, { handled }),
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
  // The help assistant (features/help): status, and an answer grounded in the console's corpus.
  helpStatus: () => request<{ enabled: boolean; mode: "ai" | "kb" | "off" }>("GET", "/platform/help-assistant"),
  // Quiet: a question changes nothing, so no busy bar (the panel prints) and no refetch of open pages.
  helpAnswer: (body: { question: string; history: { role: "user" | "assistant"; text: string }[] }, signal?: AbortSignal) =>
    request<{ answer: HelpAnswer; mode: "ai" | "kb" }>("POST", "/platform/help-assistant/answers", body, { quiet: true, signal }),
  // Your own pictures behind the glass: a library per operator (backdropStore.ts).
  backdrops: () => request<{ items: BackdropItem[]; selectedId: string | null; max?: number }>("GET", "/platform/me/backdrops"),
  backdropUpload: (body: { contentType: string; size: number; width: number; height: number }) =>
    request<{ id: string; url: string; fields: Record<string, string> }>("POST", "/platform/me/backdrops/upload", body),
  backdropComplete: (id: string) =>
    request<{ item: BackdropItem }>("POST", `/platform/me/backdrops/${encodeURIComponent(id)}/complete`),
  selectBackdrop: (id: string | null) => request<{ selectedId: string | null }>("PUT", "/platform/me/backdrops/selected", { id }),
  deleteBackdrop: (id: string) => request<unknown>("DELETE", `/platform/me/backdrops/${encodeURIComponent(id)}`),
};

/** Browser -> S3 straight, with the presigned POST from documentUpload(). */
export function uploadToS3(upload: { url: string; fields: Record<string, string> }, file: File): Promise<void> {
  return withBusy(() => postToS3(upload, file));
}

async function postToS3(upload: { url: string; fields: Record<string, string> }, file: File): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append("file", file);                 // must be the last field
  const res = await fetch(upload.url, { method: "POST", body: form });
  if (!res.ok) throw new ApiError(res.status, "upload_failed", "The upload was refused - is it a PDF under 10 MB?");
}
