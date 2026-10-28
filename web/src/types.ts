export type TenantStatus =
  | "provisioning" | "provisioning_failed" | "active" | "suspended" | "offboarding" | "offboarded" | "purged";

export type Features = Record<string, boolean>;

export interface Plan {
  planId: string;
  name: string;
  maxLocations: number;
  features: Features;
  /** Monthly price excluding VAT (the plan's default; a customer can have their own). */
  priceSek?: number | null;
}

export type BillingTerms = "trial" | "subscription";

export interface Address {
  street: string;
  postalCode: string;
  city: string;
  country?: string;
}

export interface StripeState {
  accountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  requirementsDue?: string[];
  disconnected?: boolean;
  updatedAt?: string;
}

export interface Tenant {
  tenantId: string;
  name: string;
  slug: string;
  status: TenantStatus;
  planId: string;
  entitlements: { maxLocations: number; features: Features };
  locationCount: number;
  ownerEmail?: string;
  ownerName?: string;
  ownerPhone?: string;
  legalName?: string;
  orgNumber?: string;
  vatNumber?: string;
  contactEmail?: string;
  contactPhone?: string;
  billingEmail?: string;
  senderName?: string;
  replyToEmail?: string;
  address?: Address;
  branding?: Record<string, unknown>;
  notes?: string;
  primaryDomain?: string;
  stripe?: StripeState;
  lastError?: string;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  offboardedAt?: string;
  /** When tenant-purge deletes the data and the website repo (set at
   * offboarding); Restore works until then. */
  purgeAt?: string;
  purgeStartedAt?: string;
  purgedAt?: string;
  billing?: Partial<Billing> & { customerId?: string };
}

export interface TenantSummary {
  tenantId: string;
  name: string;
  slug: string;
  legalName?: string;
  orgNumber?: string;
  status: TenantStatus;
  planId: string;
  locationCount: number;
  maxLocations?: number;
  chargesEnabled: boolean;
  primaryDomain?: string;
  ownerEmail?: string;
  createdAt?: string;
}

export interface Location {
  locationId: string;
  tenantId: string;
  name: string;
  address: string;
  phone?: string;
  email?: string;
  stripeAccountId?: string;
  terminal?: TerminalSetup;
  createdAt?: string;
}

export interface TerminalAddress {
  line1: string;
  postalCode: string;
  city: string;
  country?: string;
}

/** Stripe Terminal location of a restaurant location (on the restaurant's Stripe account). */
export interface TerminalSetup {
  locationId: string;
  accountId: string;
  displayName: string;
  address: TerminalAddress;
  enabledAt?: string;
}

export interface TerminalReader {
  id: string;
  label: string;
  device_type: string;
  status: "online" | "offline" | null;
  serial_number?: string;
  last_seen_at?: number;
}

/** A reader with the customer and location it belongs to (GET /platform/terminal/readers). */
export interface FleetReader extends TerminalReader {
  accountId: string;
  tenantId: string;
  tenantName?: string | null;
  /** null: on the restaurant's account, but at a Terminal Location no Booqy location has. */
  locationId: string | null;
  locationName?: string | null;
}

export interface FleetLocation {
  tenantId: string;
  tenantName?: string | null;
  tenantStatus?: string;
  locationId: string;
  locationName?: string | null;
  terminalLocationId: string;
  accountId: string;
  readerCount: number;
}

export interface ReaderFleet {
  readers: FleetReader[];
  locations: FleetLocation[];
  errors: { accountId: string; tenantId: string; tenantName?: string | null; message: string }[];
}

export interface TerminalState {
  enabled: boolean;
  inPlan: boolean;
  terminal: TerminalSetup | null;
  readers: TerminalReader[];
}

export type LocationInput = { name: string; address: string; phone?: string; email?: string; stripeAccountId?: string };

export interface Domain {
  domain: string;
  kind: "platform" | "custom";
  status: string;
  primary: boolean;
  lastError?: string;
  distributionTenantId?: string;
}

export interface Money {
  amount: number;
  currency: string;
}

/** A domain we run DNS for (bought through Route 53, or connected). */
export interface Zone {
  domain: string;
  mode: "register" | "connect";
  status: string;
  statusDetail?: string;
  nameServers?: string[];
  price?: Money;
  renewalPrice?: Money;
  makePrimary?: boolean;
  lastError?: string;
  requestedAt?: string;
  requestedBy?: string;
  updatedAt?: string;
  importedRecords?: number;
  verificationRequired?: boolean;
  hasDocument: boolean;
  supportCase?: SupportCase;
  registrar?: "route53" | "external";
  transferable?: boolean;
  transfer?: {
    status: string;
    statusDetail?: string;
    price?: Money;
    error?: string;
    requestedAt?: string;
    completedAt?: string;
    supportCase?: SupportCase;
  };
}

export interface TransferCheck {
  domain: string;
  transferable: boolean;
  transferability?: string;
  reason?: string | null;
  price?: Money | null;
  renewalPrice?: Money | null;
  verificationRequired?: boolean;
}

export interface DomainOffer {
  domain: string;
  availability: string;
  available: boolean;
  sellable: boolean;
  verificationRequired: boolean;
  price?: Money | null;
  renewalPrice?: Money | null;
}

export interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  values: string[];
  skip?: string | null;
}

export interface DnsScan {
  domain: string;
  nameServers: string[];
  dnssec: boolean;
  registered: boolean;
  records: DnsRecord[];
}

export interface SupportCase {
  service: string;
  category: string;
  subject: string;
  body: string;
}

export interface RegistrantContact {
  legalName: string;
  orgNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: { street: string; postalCode: string; city: string };
}

export interface AuditEntry {
  action: string;
  by: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface TenantDetail {
  tenant: Tenant;
  domains: Domain[];
  zones: Zone[];
  locations: Location[];
  userCount: number;
  onboarding: { status: string; startDate: string; stopDate?: string } | null;
  audit: AuditEntry[];
}

export interface TenantUser {
  cognitoSub: string;
  email: string;
  name?: string;
  role: "owner_user" | "staff_user";
  status?: string;
  locationId?: string;
  createdAt?: string;
}

export interface NewTenantInput {
  name: string;
  slug: string;
  planId: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone?: string;
  legalName?: string;
  orgNumber?: string;
  vatNumber?: string;
  contactEmail?: string;
  contactPhone?: string;
  billingEmail?: string;
  senderName?: string;
  replyToEmail?: string;
  billing?: { terms: BillingTerms; priceSek?: number; startInvoicing?: boolean; startDate?: string;
              collectionMethod?: "send_invoice" | "charge_automatically" };
  address?: Address;
  notes?: string;
  overrides?: { maxLocations?: number };
  locations: LocationInput[];
}

export interface OperatorAccount {
  username: string;
  email: string;
  name: string;
  /** FORCE_CHANGE_PASSWORD = invited, hasn't signed in yet */
  status: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Dev mail outbox (GET /platform/outbox) - dev only. */
export interface OutboxSummary {
  id: string;
  at: string;
  channel: "email" | "sms";
  to: string;
  /** Email subject, or the first 120 characters of an SMS. */
  subject: string | null;
}

export interface OutboxMessage {
  id: string;
  at: string;
  channel: "email" | "sms";
  to: string;
  from?: string | null;
  replyTo?: string[];
  subject?: string;
  text?: string;
  html?: string | null;
}

/** News to the restaurant owners (Mail page). */
export interface MailLogo {
  kind: "booqy" | "custom";
  name?: string | null;
  /** The logo as shown in the email (data URI), for the picker's preview. */
  dataUrl: string;
}

export interface MailTemplate {
  senderName: string;
  replyTo: string;
  accentColor: string;
  signature: string;
  footer: string;
  logo: MailLogo;
  /** The no-reply address the platform sends from (read-only). */
  from: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface MailTemplateInput {
  senderName: string;
  replyTo: string;
  accentColor: string;
  signature: string;
  footer: string;
  /** dataUrl only when a new file was picked; without it the uploaded logo is kept. */
  logo: { kind: "booqy" } | { kind: "custom"; dataUrl?: string; name?: string };
}

export interface MailRecipient {
  email: string;
  name: string;
  tenantName: string;
  tenantId: string;
}

export type NewsletterStatus = "sending" | "sent" | "partly_sent" | "failed";

export interface Newsletter {
  newsletterId: string;
  subject: string;
  body: string;
  status: NewsletterStatus;
  createdAt: string;
  createdBy: string;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  finishedAt?: string;
  lastError?: string;
}

export interface NewsletterRecipient {
  email: string;
  tenantName: string;
  status: "pending" | "sent" | "failed";
  error?: string;
}

// ------------------------------------------------------------------ finance
/** Where a customer's agreement stands; past_due only on Finance rows while an invoice is overdue. */
export type BillingStatus = "none" | "scheduled" | "active" | "ending" | "ended" | "past_due";

export interface BillingPlan {
  planId?: string;
  name?: string;
  priceSek?: number | null;
}

/** What the next invoice (on the 25th, for the period 25th to 24th) would carry. */
export interface InvoicePlan {
  periodStart: string;
  periodEnd: string;
  period: string;
  days: number;
  activeDays: number;
  monthlySek: number;
  feeSek: number;
  feeText: string;
  smsParts: number;
  smsMessages?: number;
  smsByLocation?: Record<string, number>;
  smsPriceSek: number;
  smsSek: number;
  smsText: string;
  totalSek: number;
  final: boolean;
  nothingToInvoice?: boolean;
}

export interface Billing {
  customerId?: string;
  status: BillingStatus;
  subscribed: boolean;
  /** trial = try-out period: leaves with the current period, becomes a subscription after trialMonths; subscription = notice period. */
  terms: BillingTerms;
  termsSince?: string;
  trialEndsAt?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  /** The customer's own monthly price ex VAT, or null for the plan's. */
  priceSek?: number | null;
  /** What they pay per period ex VAT (own price or the plan's). */
  monthlySek?: number | null;
  /** The customer's own price per SMS part, or null for the default. */
  smsPriceSek?: number | null;
  /** The price per SMS part in force. */
  smsPrice: number;
  smsPriceDefaultSek: number;
  collectionMethod: "send_invoice" | "charge_automatically";
  hasCard: boolean;
  pastDueSince?: string;
  autoSuspended: boolean;
  lastPaidAt?: string;
  lastPaymentFailedAt?: string;
  startedAt?: string;
  startedBy?: string;
  lastInvoicedPeriodEnd?: string | null;
  offboardAtEnd: boolean;
  noticeMonths: number;
  trialMonths: number;
  daysUntilDue: number;
  suspendAfterDays: number;
  plan: BillingPlan;
  legacySubscriptionId?: string | null;
  pendingSubscriptionId?: string | null;
  /** The current period so far (SMS counted to date); null when nothing runs. */
  nextInvoice: (InvoicePlan & { date: string; dueDate: string; smsSoFar: boolean }) | null;
  /** Complete periods not invoiced yet (a missed run). */
  pendingPeriods: number;
  /** Earlier agreements that ended but are still on the next invoice (left and came back). */
  previous?: { startsAt: string; endsAt: string }[];
}

export interface Invoice {
  invoiceId: string;
  number?: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  subtotalSek: number;
  taxSek: number;
  totalSek: number;
  amountPaidSek: number;
  amountRemainingSek: number;
  outstandingSek: number;
  createdAt?: string;
  dueDate?: string;
  paidAt?: string;
  periodStart?: string;
  periodEnd?: string;
  hostedInvoiceUrl?: string;
  invoicePdf?: string;
  paidOutOfBand: boolean;
  /** yyyy-mm of the period the invoice is for */
  month?: string | null;
  daysLate: number;
  remindersSent: number;
  lastReminderAt?: string;
  lateFeeSek?: number | null;
  interestSek?: number | null;
  collectionMethod?: "send_invoice" | "charge_automatically" | null;
  /** The period's lines, when the console built the invoice. */
  feeSek?: number | null;
  smsParts?: number | null;
  smsSek?: number | null;
}

/** One line of an invoicing run (preview or real). */
export interface InvoicingLine extends InvoicePlan {
  tenantId: string;
  name: string;
  invoiceId?: string | null;
  number?: string;
  delivery?: string;
  hostedInvoiceUrl?: string;
}

export interface InvoicingRun {
  dryRun: boolean;
  today: string;
  invoices: InvoicingLine[];
  skipped: InvoicingLine[];
  errors: { tenantId: string; name: string; error: string }[];
  migrated: { tenantId: string; name: string }[];
  totalSek: number;
}

/** One row of the Payments view: an invoice with its customer. */
export interface PaymentRow extends Invoice {
  tenantId: string;
  name: string;
  slug: string;
  orgNumber?: string;
  tenantStatus: TenantStatus;
}

export interface PaymentsView {
  period: { from: string; to: string; status: string };
  summary: {
    invoices: number; paid: number; open: number; overdue: number;
    invoicedSek: number; collectedSek: number; outstandingSek: number; overdueSek: number;
    lateFeesSek: number; interestSek: number;
  };
  invoices: PaymentRow[];
}

export interface BillingView {
  billing: Billing;
  invoices: Invoice[];
}

export interface FinanceKpis {
  mrrSek: number;
  revenueSek: number;
  collectedSek: number;
  outstandingSek: number;
  /** The whole AWS bill ("platform") without a customer filter, else the customer's allocated share. */
  costSek: number;
  costScope?: "platform" | "allocated";
  /** The part of costSek allocated to the customers shown. */
  allocatedCostSek?: number;
  /** Bill not allocated to the customers shown: days nobody was active, customers left out by the filter. */
  unallocatedSek?: number;
  /** The whole bill per bucket (platform scope only). */
  costSplitSek?: { baseline: number; requests: number; email: number; sms: number } | null;
  marginSek: number;
  marginPct: number | null;
  customers: number;
  activeCustomers: number;
  payingCustomers: number;
  newCustomers: number;
  churnedCustomers: number;
  churnPct: number | null;
  arpuSek: number | null;
  bookings: number;
  orders: number;
  costPerBookingSek: number | null;
  costPerOrderSek: number | null;
  requests: number;
  emails: number;
  sms: number;
  /** SMS parts the restaurants are charged for, what that earns and the SMS share of the AWS bill. */
  smsParts: number;
  smsRevenueSek: number;
  smsCostSek: number;
  smsMarginSek: number;
}

export interface FinancePoint {
  day: string;
  invoicedSek: number;
  paidSek: number;
  costSek: number;
  mrrSek: number;
  bookings: number;
  orders: number;
  requests: number;
  activeTenants: number;
  smsParts?: number;
  smsRevenueSek?: number;
}

export interface FinanceTenantRow {
  tenantId: string;
  name: string;
  slug: string;
  orgNumber?: string;
  legalName?: string;
  status: TenantStatus;
  planId?: string;
  billingStatus: BillingStatus;
  pastDueSince?: string;
  mrrSek: number;
  revenueSek: number;
  collectedSek: number;
  creditedSek: number;
  outstandingSek: number;
  costSek: number;
  costSplitSek: { baseline: number; requests: number; email: number; sms: number };
  marginSek: number;
  marginPct: number | null;
  bookings: number;
  orders: number;
  requests: number;
  emails: number;
  sms: number;
  marketingEmails: number;
  smsParts: number;
  smsRevenueSek: number;
  smsCostSek: number;
  smsMarginSek: number;
  smsByType?: { booking: number; reminder: number; order: number; catering: number };
  costPerBookingSek: number | null;
  costPerOrderSek: number | null;
  activeDays: number;
  invoiceCount: number;
  createdAt?: string;
  offboardedAt?: string;
}

export interface FinanceJob {
  startedAt?: string;
  finishedAt?: string;
  days?: string[];
  done?: string[];
  warnings: string[];
}

export interface FinanceOverview {
  period: { from: string; to: string; days: number; includeInactive: boolean; tenantId: string | null;
            locationId?: string | null; revenueScope?: "tenant" | null };
  /** The picked customer's locations (for the location filter). */
  locations?: { locationId: string; name?: string }[];
  kpis: FinanceKpis;
  series: FinancePoint[];
  tenants: FinanceTenantRow[];
  attention: {
    pastDue: { tenantId: string; name: string; since: string; status: TenantStatus }[];
    noSubscription: { tenantId: string; name: string; createdAt?: string }[];
  };
  job: FinanceJob | null;
  asOf: string | null;
  /** Newest day the AWS cost is known for (Cost Explorer lags about a day). */
  costAsOf?: string | null;
}

export interface FinanceTenantDetail {
  period: { from: string; to: string };
  tenant: FinanceTenantRow;
  series: FinancePoint[];
  days: Record<string, unknown>[];
  invoices: Invoice[];
}

/** One deploy run of a site repo (GitHub Actions, workflow Deploy). */
export interface SiteDeploy {
  status: string;
  conclusion: string | null;
  sha: string;
  at: string;
  by: string | null;
  event: string;
  url: string;
}

/** Where one environment's site answers: its slug address always, its
 * own domain once mounted (prod www.<domain>, dev dev.<domain>). */
export interface SiteHosting {
  slugUrl?: string | null;
  host?: string | null;
  state: "slug_only" | "not_mounted" | "attaching" | "live" | "failed" | "unknown";
  /** The domain row's own status (pending_dns, pending_validation, ...). */
  status?: string | null;
  lastError?: string | null;
  /** The CNAME target of that environment's restaurant-site distribution. */
  cnameTarget?: string;
  canMount?: boolean;
  /** Booqy runs the domain's DNS: Mount writes the record itself. */
  dnsByBooqy?: boolean;
  /** Dev: the own domain that has to be live in production first. */
  waitsFor?: string | null;
}

/** Website tab: the restaurant's own site repo site-<slug>. */
export interface SiteStatus {
  enabled: true;
  repo: string;
  org: string;
  environment: "dev" | "prod";
  status: "none" | "simulated" | "creating" | "ready" | "failed" | "archived";
  /** Dev dry run: what the production console would create. */
  plan?: string[];
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  repoExists?: boolean;
  repoUrl?: string;
  archived?: boolean;
  deploys?: { dev: SiteDeploy | null; prod: SiteDeploy | null };
  /** Prod console: both environments; dev console: dev only. */
  hosting?: Partial<Record<"dev" | "prod", SiteHosting>>;
  /** This environment's booqy.json section: public values only. */
  config: {
    tenantId: string;
    apiBaseUrl: string;
    menuImageBaseUrl: string;
    stripePublishableKey: string;
    turnstileSiteKey: string;
    previewUrl?: string;
    domain?: string;
  };
}
