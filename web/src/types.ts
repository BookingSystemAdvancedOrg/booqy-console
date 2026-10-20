export type TenantStatus =
  | "provisioning" | "provisioning_failed" | "active" | "suspended" | "offboarding" | "offboarded" | "purged";

export type Features = Record<string, boolean>;

export interface Plan {
  planId: string;
  name: string;
  maxLocations: number;
  features: Features;
}

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
  /** When tenant-purge deletes the data (set at offboarding). */
  purgeAt?: string;
  purgedAt?: string;
}

export interface TenantSummary {
  tenantId: string;
  name: string;
  slug: string;
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
