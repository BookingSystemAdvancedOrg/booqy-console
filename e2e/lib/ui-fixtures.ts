import type { Page } from '@playwright/test'
import { websiteFixture } from '../../web/src/test/websiteFixture'

/**
 * Stubbed Cognito session + stubbed API for the UI suite. Nothing leaves the
 * machine: every call to https://api.e2e.test/** is answered here.
 */
export const CLIENT_ID = 'e2eclient'
export const USERNAME = 'e2e-operator'
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`

export async function fakeSession(page: Page) {
  const now = Math.floor(Date.now() / 1000)
  const base = { sub: 'sub-e2e', iss: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_E2EPOOL', client_id: CLIENT_ID, iat: now, exp: now + 3600 * 24 * 365, username: USERNAME }
  const access = jwt({ ...base, token_use: 'access', 'cognito:groups': ['platform_admin'] })
  const id = jwt({ ...base, token_use: 'id', aud: CLIENT_ID, email: 'operator@booqy.test', 'cognito:username': USERNAME })
  const p = `CognitoIdentityServiceProvider.${CLIENT_ID}`
  await page.addInitScript(({ p, access, id, user }) => {
    try {
      localStorage.setItem(`${p}.LastAuthUser`, user)
      localStorage.setItem(`${p}.${user}.accessToken`, access)
      localStorage.setItem(`${p}.${user}.idToken`, id)
      localStorage.setItem(`${p}.${user}.refreshToken`, 'refresh')
      localStorage.setItem(`${p}.${user}.clockDrift`, '0')
    } catch { /* ignore */ }
  }, { p, access, id, user: USERNAME })
}

const plans = [
  { planId: 'free', name: 'Free', maxLocations: 3, features: { booking: true, ordering: true }, priceSek: 0, free: true },
  { planId: 'starter', name: 'Starter', maxLocations: 1, features: { booking: true }, priceSek: 990 },
  { planId: 'growth', name: 'Growth', maxLocations: 5, features: { booking: true, ordering: true, catering: true }, priceSek: 1990 },
]
const tenants = [
  { tenantId: 't1', name: 'Pizzeria Roma', slug: 'pizzeria-roma', legalName: 'Roma Restaurang AB', orgNumber: '556677-8899', status: 'active', planId: 'starter', locationCount: 1, maxLocations: 1, chargesEnabled: true, ownerEmail: 'roma@example.test', createdAt: '2026-09-01T10:00:00Z' },
  { tenantId: 't2', name: 'Bistro Linnea med ett mycket långt namn som måste radbrytas snyggt', slug: 'linnea', status: 'active', planId: 'growth', locationCount: 2, maxLocations: 5, chargesEnabled: true, primaryDomain: 'linnea.example.test', ownerEmail: 'linnea@example.test', createdAt: '2026-09-10T10:00:00Z' },
  { tenantId: 't3', name: 'Café Solrosen', slug: 'solrosen', status: 'suspended', planId: 'free', locationCount: 1, chargesEnabled: false, freeUntil: '2027-02-14', createdAt: '2026-10-01T10:00:00Z' },
  { tenantId: 't4', name: 'Krogen Norr', slug: 'norr', status: 'provisioning_failed', planId: 'starter', locationCount: 1, chargesEnabled: false, createdAt: '2026-11-01T10:00:00Z' },
]
const billing = {
  status: 'active', subscribed: true, terms: 'subscription', collectionMethod: 'send_invoice', hasCard: false, autoSuspended: false, offboardAtEnd: false,
  noticeMonths: 1, trialMonths: 3, daysUntilDue: 30, suspendAfterDays: 30, monthlySek: 990, priceSek: null, plan: { planId: 'starter', name: 'Starter', priceSek: 990 },
}
const invoice = (n: number, status: string) => ({ invoiceId: 'in_' + n, number: 'BQ-2026-00' + n, status, subtotalSek: 990, taxSek: 247.5, totalSek: 1237.5, amountPaidSek: status === 'paid' ? 1237.5 : 0, amountRemainingSek: status === 'paid' ? 0 : 1237.5, outstandingSek: status === 'paid' ? 0 : 1237.5, createdAt: '2026-10-01T00:00:00Z', dueDate: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31', paidOutOfBand: false, month: '2026-10', daysLate: status === 'open' ? 14 : 0, remindersSent: 0 })
const overview = {
  period: { from: '2026-10-01', to: '2026-10-21', days: 21, includeInactive: false, tenantId: null },
  kpis: { mrrSek: 2980, revenueSek: 2880, collectedSek: 990, outstandingSek: 1990, costSek: 100, marginSek: 2780, marginPct: 96.5, customers: 2, activeCustomers: 2, payingCustomers: 2, newCustomers: 0, churnedCustomers: 0, churnPct: 0, arpuSek: 1490, bookings: 23, orders: 11, costPerBookingSek: 4.35, costPerOrderSek: 9.09, requests: 650, emails: 5, sms: 0, smsParts: 412, smsCostSek: 61.5, freeCustomers: 1 },
  series: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: `2026-10-0${d}`, invoicedSek: 400 * d, paidSek: 100 * d, costSek: 10 + d, mrrSek: 2980, bookings: 3 + d, orders: d, requests: 100 * d, activeTenants: 2 })),
  tenants: [
    { tenantId: 't2', name: 'Bistro Linnea', slug: 'linnea', orgNumber: '556000-0001', status: 'active', planId: 'growth', billingStatus: 'active', mrrSek: 1990, revenueSek: 1890, collectedSek: 0, creditedSek: 100, outstandingSek: 1990, costSek: 70, costSplitSek: { baseline: 10, requests: 60, email: 0, sms: 0 }, marginSek: 1820, marginPct: 96.3, bookings: 18, orders: 9, requests: 500, emails: 0, sms: 0, marketingEmails: 0, costPerBookingSek: 3.89, costPerOrderSek: 7.78, activeDays: 2, invoiceCount: 1, smsParts: 300, smsCostSek: 45 },
    { tenantId: 't1', name: 'Pizzeria Roma', slug: 'pizzeria-roma', orgNumber: '556677-8899', status: 'active', planId: 'starter', billingStatus: 'past_due', pastDueSince: '2026-10-10T00:00:00Z', mrrSek: 990, revenueSek: 990, collectedSek: 990, creditedSek: 0, outstandingSek: 0, costSek: 30, costSplitSek: { baseline: 10, requests: 15, email: 5, sms: 0 }, marginSek: 960, marginPct: 97, bookings: 5, orders: 2, requests: 150, emails: 5, sms: 0, marketingEmails: 0, costPerBookingSek: 6, costPerOrderSek: 15, activeDays: 2, invoiceCount: 1, smsParts: 112, smsCostSek: 16.5, free: true, freeUntil: '2027-02-14' },
  ],
  attention: { pastDue: [{ tenantId: 't1', name: 'Pizzeria Roma', since: '2026-10-10T00:00:00Z', status: 'active' }], noSubscription: [] },
  job: { finishedAt: '2026-10-21T04:35:00Z', warnings: [] },
  asOf: '2026-10-21T04:35:00Z',
}
const operators = [
  { username: 'e2e-operator', email: 'operator@booqy.test', name: 'Test Operator', status: 'CONFIRMED', enabled: true, createdAt: '2026-08-01T10:00:00Z' },
  { username: 'anna', email: 'anna.med.ett.valdigt.langt.efternamn@booqy.test', name: 'Anna Långnamnsson', status: 'FORCE_CHANGE_PASSWORD', enabled: true },
]
const template = { senderName: 'Booqy', replyTo: 'hej@booqy.test', accentColor: '#350001', signature: 'Hälsningar, Booqy', footer: 'Booqy AB', logo: { kind: 'booqy', dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }, from: 'no-reply@booqy.test' }

function body(method: string, path: string): unknown {
  if (method !== 'GET') return {}
  if (path === '/platform/plans') return { plans }
  if (path === '/platform/tenants') return { tenants }
  if (/^\/platform\/tenants\/[^/]+$/.test(path)) {
    const id = path.split('/').pop()
    const s = tenants.find((t) => t.tenantId === id) ?? tenants[0]
    return { tenant: { ...s, entitlements: { maxLocations: s.maxLocations ?? 1, features: { booking: true } }, ownerName: 'Olle Ägare', ownerEmail: s.ownerEmail ?? 'o@example.test', billing: { ...billing }, address: { street: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm' }, createdAt: s.createdAt }, domains: [{ domain: `${s.slug}.dev.booqy.se`, kind: 'platform', status: 'active', primary: true }], zones: [], locations: [{ locationId: 'l1', tenantId: s.tenantId, name: 'Huvudkrogen', address: 'Storgatan 1, Stockholm' }], userCount: 2, onboarding: null, audit: [{ action: 'tenant.created', by: 'anna', at: '2026-09-01T10:00:00Z' }] }
  }
  if (/\/users$/.test(path)) return { users: [{ cognitoSub: 'u1', email: 'owner@example.test', name: 'Olle Ägare', role: 'owner_user', status: 'CONFIRMED' }, { cognitoSub: 'u2', email: 'staff@example.test', role: 'staff_user', status: 'CONFIRMED' }] }
  if (/\/billing$/.test(path)) return { billing, invoices: [invoice(1, 'paid'), invoice(2, 'open')] }
  if (/\/site$/.test(path)) return { enabled: false }
  if (path === '/platform/finance/overview') return overview
  if (path === '/platform/finance/invoices') return { period: { from: '2026-10-01', to: '2026-10-31', status: 'all' }, summary: { invoices: 2, paid: 1, open: 1, overdue: 1, invoicedSek: 2475, collectedSek: 1237.5, outstandingSek: 1237.5, overdueSek: 1237.5, lateFeesSek: 0, interestSek: 0 }, invoices: [invoice(1, 'paid'), invoice(2, 'open')].map((i) => ({ ...i, tenantId: 't1', name: 'Pizzeria Roma', slug: 'pizzeria-roma', tenantStatus: 'active' })) }
  if (path === '/platform/website') return websiteFixture()
  if (path === '/platform/operators') return { operators }
  if (path === '/platform/me/avatar') return { url: null }
  if (path === '/platform/me/backdrops') return { items: [], selectedId: null, max: 3 }
  if (path === '/platform/mail/template') return { template }
  if (path === '/platform/mail/recipients') return { count: 2, recipients: [{ email: 'roma@example.test', name: 'Olle', tenantName: 'Pizzeria Roma', tenantId: 't1' }, { email: 'linnea@example.test', name: 'Lin', tenantName: 'Bistro Linnea', tenantId: 't2' }] }
  if (path === '/platform/mail/newsletters') return { newsletters: [{ newsletterId: 'n1', subject: 'Nyheter i november', body: 'Hej!', status: 'sent', createdAt: '2026-11-01T10:00:00Z', createdBy: 'anna', recipientCount: 2, sentCount: 2, failedCount: 0, finishedAt: '2026-11-01T10:01:00Z' }] }
  if (path === '/platform/outbox') return { enabled: true, messages: [{ id: 'm1', at: '2026-11-13T10:00:00Z', channel: 'email', to: 'roma@example.test', subject: 'Välkommen till Booqy' }, { id: 'm2', at: '2026-11-13T11:00:00Z', channel: 'sms', to: '+46700000000', subject: 'Din kod är 123456' }], next: null }
  if (path === '/platform/help-assistant') return { enabled: true, mode: 'kb' }
  return {}
}

/** Answers every API call; returns the list of unhandled paths for debugging. */
export async function stubApi(page: Page) {
  await page.route('https://api.e2e.test/**', async (route) => {
    const u = new URL(route.request().url())
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }, body: JSON.stringify(route.request().method() === 'OPTIONS' ? {} : body(route.request().method(), u.pathname)) })
  })
  // Cognito: token refresh must never leave the machine
  await page.route('https://cognito-idp.eu-north-1.amazonaws.com/**', (route) => route.abort())
}
