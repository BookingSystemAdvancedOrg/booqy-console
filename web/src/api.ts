import { AuthUnavailableError, accessToken, notifySignedOut, refreshedAccessToken, signOut } from "./auth";
import { withBusy } from "./busy";
import { isQuiet, notifySaved } from "./live";
import type { WebsiteOverview } from "./website";
import type { HelpAnswer } from "./features/help/kb";
import type {
  DevTwin,
  BillingView, CreditNotesResponse, DnsRecord, FreeInput, DnsScan, DomainOffer, FinanceOverview, FinanceTenantDetail, InvoicingRun, Money, PaymentsView, RegistrantContact, SimulateEvent, SiteStatus, SupportCase, SupportReport, TransferCheck, TransferInCheck, Zone,
  AddedPrinter, Location, LocationInput, LocationPrinters, MailRecipient, Printer, PrinterKind, PrinterStatus, PrinterSummary, MailTemplate, MailTemplateInput, NewTenantInput, Newsletter, NewsletterRecipient, OperatorAccount, OperatorList, OutboxMessage, OutboxSummary, Plan, StaffAccess, Tenant, TenantDetail, TenantSummary, TenantUser,
} from "./types";

export type BackdropItem = { id: string; url: string; thumbUrl: string; uploadedAt: string; width: number; height: number };

export class ApiError extends Error {
  /** The API's own message ("" when it had none). errors.ts shows it only for a code it doesn't know, and only when it reads plainly. */
  serverMessage?: string;
  /** A feature's own text for this status (RequestOptions.messages): shown as written. */
  ownMessage?: string;

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

/** API Gateway's request id: the body's (platform-tenants puts it in 500s), else the header when it is readable. */
function requestIdOf(res: Response, extra: Record<string, unknown>): string | undefined {
  const raw = typeof extra.requestId === "string" ? extra.requestId : res.headers?.get?.("apigw-requestid");
  return raw && /^[A-Za-z0-9=_.:-]{1,100}$/.test(raw) ? raw : undefined;
}

/** quiet: no busy bar and no "data changed" signal (a read-only POST with its own animation, as the help assistant's). signal: abort the call.
 * messages: a feature's own text for an error status (features/*: "not deployed here" for a 404), used in place of the API's. */
export type RequestOptions = { quiet?: boolean; signal?: AbortSignal; messages?: ErrorMessages };
export type ErrorMessages = (status: number, code: string) => string | undefined;

// Every call shows the busy bar (busy.ts), so no load is ever silent; only
// the quiet live refetches (live.ts quietly) and opts.quiet skip it. After a
// write, every live page refetches at once (also after a 409: someone saved
// in between).
export function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  if (opts.quiet || (isQuiet() && method === "GET")) return send<T>(method, path, body, opts.signal, opts.messages);
  const call = withBusy(() => send<T>(method, path, body, opts.signal, opts.messages));
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

async function send<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, messages?: ErrorMessages): Promise<T> {
  const offline = () => new ApiError(0, "network", "We can't reach Booqy right now. Check your internet and try again.");
  const call = async (token: string) => {
    try {
      return await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch {
      if (signal?.aborted) throw new ApiError(0, "timeout", "Booqy took too long to answer. Try again in a moment.");
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
      throw new ApiError(401, "unauthorized", "You were signed out. Sign in again, then redo your last step.");
    }
  }
  // The timeout can also fire while the body is still arriving: the same timeout then;
  // a connection lost mid-body is offline, like one lost before.
  let text: string;
  try {
    text = await res.text();
  } catch {
    if (signal?.aborted) throw new ApiError(0, "timeout", "Booqy took too long to answer. Try again in a moment.");
    throw offline();
  }
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new ApiError(res.status, "bad_response", "Booqy sent an answer we can't read.");
  }
  if (!res.ok) {
    const { error, message, fields, ...extra } = data;
    const requestId = requestIdOf(res, extra);
    if (requestId) extra.requestId = requestId;
    // The generic 500 text says nothing useful - give what to do instead.
    const code = typeof error === "string" && error ? error : res.status >= 500 ? "internal_error" : "error";
    const own = messages?.(res.status, code);
    const server = typeof message === "string" && message && !(res.status >= 500 && error === "internal_error") ? message : "";
    // The message stays the API's own (logs, tests); people read errors.ts's text, never this.
    const err = new ApiError(res.status, code, own || server || code, (fields as Record<string, string>) ?? {}, extra);
    err.serverMessage = server;
    if (own) err.ownMessage = own;
    throw err;
  }
  return data as T;
}

const t = (id: string) => `/platform/tenants/${encodeURIComponent(id)}`;
const printersPath = (id: string, locationId: string) => `${t(id)}/locations/${encodeURIComponent(locationId)}/printers`;
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
  // Dev only: create or refresh the customer's dev twin (test data in every Kom igång step)
  devTwin: (id: string) => request<{ devTwin: DevTwin }>("POST", `${t(id)}/dev-twin`, {}),
  // Dev only: copy the real restaurant's public content from prod's public API now
  devTwinContent: (id: string) => request<{ devTwinContent: DevTwin }>("POST", `${t(id)}/dev-twin/content`, {}),
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
  users: (id: string) => request<{ users: TenantUser[]; access: StaffAccess | null }>("GET", `${t(id)}/users`),
  inviteOwner: (id: string, email: string, name: string) => request("POST", `${t(id)}/owners`, { email, name }),
  createUser: (id: string, body: Record<string, unknown>) => request<{ user: TenantUser }>("POST", `${t(id)}/users`, body),
  updateUser: (id: string, userId: string, patch: Record<string, unknown>) =>
    request<{ user: TenantUser; inviteResent: boolean }>("PATCH", `${t(id)}/users/${encodeURIComponent(userId)}`, patch),
  deleteUser: (id: string, userId: string) => request("DELETE", `${t(id)}/users/${encodeURIComponent(userId)}`),
  disableUser: (id: string, userId: string) => request("POST", `${t(id)}/users/${encodeURIComponent(userId)}/disable`, {}),
  enableUser: (id: string, userId: string) => request("POST", `${t(id)}/users/${encodeURIComponent(userId)}/enable`, {}),
  resendUserInvite: (id: string, userId: string) =>
    request("POST", `${t(id)}/users/${encodeURIComponent(userId)}/resend-invite`, {}),
  createLocation: (id: string, loc: LocationInput) =>
    request<{ location: Location }>("POST", `${t(id)}/locations`, loc),
  updateLocation: (id: string, locationId: string, patch: Partial<LocationInput>) =>
    request<{ location: Location }>("PATCH", `${t(id)}/locations/${encodeURIComponent(locationId)}`, patch),
  deleteLocation: (id: string, locationId: string) =>
    request("DELETE", `${t(id)}/locations/${encodeURIComponent(locationId)}`),
  // Printers: each location's status (Locations tab, the badge in Customers) and the operator's changes
  printerSummary: () =>
    request<{ tenants: Record<string, PrinterSummary> }>("GET", "/platform/printers").then((r) => r.tenants),
  tenantPrinters: (id: string) =>
    request<{ locations: LocationPrinters[]; status: PrinterStatus | null }>("GET", `${t(id)}/printers`),
  addPrinter: (id: string, locationId: string, body: { name: string; kind: PrinterKind; protocol?: "star" | "epson" | "sim" }) =>
    request<AddedPrinter>("POST", printersPath(id, locationId), body),
  updatePrinter: (id: string, locationId: string, deviceId: string, patch: { name?: string; kind?: PrinterKind }) =>
    request<{ printer: Printer }>("PATCH", `${printersPath(id, locationId)}/${encodeURIComponent(deviceId)}`, patch),
  testPrinter: (id: string, locationId: string, deviceId: string) =>
    request<{ status: string }>("POST", `${printersPath(id, locationId)}/${encodeURIComponent(deviceId)}/test`, {}),
  removePrinter: (id: string, locationId: string, deviceId: string) =>
    request<LocationPrinters>("DELETE", `${printersPath(id, locationId)}/${encodeURIComponent(deviceId)}`),
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
  creditNotes: (id: string, body: { items: { invoiceId: string; amountSek: string; attempt?: number }[]; method: "refund" | "credit";
                                   reason: string; memo?: string; requestId: string }) =>
    request<CreditNotesResponse>("POST", `${t(id)}/billing/credit-notes`, body),
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
  // Quiet: a preview saves nothing, so no busy bar and no refetch of open pages on every typing pause.
  mailPreview: (body: { subject: string; body: string; template?: Partial<MailTemplateInput> }) =>
    request<{ subject: string; html: string; text: string }>("POST", "/platform/mail/preview", body, { quiet: true }),
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
  if (!res.ok) throw new ApiError(res.status, "upload_failed", "The file didn't upload. Pick a PDF under 10 MB and try again.");
}
