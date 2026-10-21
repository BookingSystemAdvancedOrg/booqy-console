import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinanceOverview, TenantSummary } from "../types";

const mocks = vi.hoisted(() => ({
  financeOverview: vi.fn(),
  tenants: vi.fn(),
  financeRebuild: vi.fn(),
  financeStripeSync: vi.fn(),
  financeInvoices: vi.fn(),
  remindInvoice: vi.fn(),
  financeInvoicing: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import FinancePage from "./FinancePage";

const tenants: TenantSummary[] = [
  { tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", orgNumber: "556677-8899", status: "active", planId: "starter", locationCount: 1, chargesEnabled: true },
  { tenantId: "t2", name: "Bistro Linnea", slug: "linnea", status: "active", planId: "growth", locationCount: 2, chargesEnabled: true },
];

function overview(extra: Partial<FinanceOverview> = {}): FinanceOverview {
  return {
    period: { from: "2026-10-01", to: "2026-10-21", days: 21, includeInactive: false, tenantId: null },
    kpis: {
      mrrSek: 2980, revenueSek: 2880, collectedSek: 990, outstandingSek: 1990, costSek: 100, marginSek: 2780, marginPct: 96.5,
      customers: 2, activeCustomers: 2, payingCustomers: 2, newCustomers: 0, churnedCustomers: 0, churnPct: 0, arpuSek: 1490,
      bookings: 23, orders: 11, costPerBookingSek: 4.35, costPerOrderSek: 9.09, requests: 650, emails: 5, sms: 0,
      smsParts: 412, smsRevenueSek: 288.4, smsCostSek: 61.5, smsMarginSek: 226.9,
    },
    series: [
      { day: "2026-10-01", invoicedSek: 2980, paidSek: 0, costSek: 60, mrrSek: 2980, bookings: 14, orders: 7, requests: 400, activeTenants: 2 },
      { day: "2026-10-02", invoicedSek: -100, paidSek: 990, costSek: 40, mrrSek: 2980, bookings: 9, orders: 4, requests: 250, activeTenants: 2 },
    ],
    tenants: [
      { tenantId: "t2", name: "Bistro Linnea", slug: "linnea", orgNumber: "556000-0001", status: "active", planId: "growth", billingStatus: "active",
        mrrSek: 1990, revenueSek: 1890, collectedSek: 0, creditedSek: 100, outstandingSek: 1990, costSek: 70,
        costSplitSek: { baseline: 10, requests: 60, email: 0, sms: 0 }, marginSek: 1820, marginPct: 96.3, bookings: 18, orders: 9,
        requests: 500, emails: 0, sms: 0, marketingEmails: 0, costPerBookingSek: 3.89, costPerOrderSek: 7.78, activeDays: 2, invoiceCount: 1,
        smsParts: 300, smsRevenueSek: 210, smsCostSek: 45, smsMarginSek: 165 },
      { tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", orgNumber: "556677-8899", status: "active", planId: "starter", billingStatus: "past_due",
        pastDueSince: "2026-10-10T00:00:00Z", mrrSek: 990, revenueSek: 990, collectedSek: 990, creditedSek: 0, outstandingSek: 0, costSek: 30,
        costSplitSek: { baseline: 10, requests: 15, email: 5, sms: 0 }, marginSek: 960, marginPct: 97, bookings: 5, orders: 2,
        requests: 150, emails: 5, sms: 0, marketingEmails: 0, costPerBookingSek: 6, costPerOrderSek: 15, activeDays: 2, invoiceCount: 1,
        smsParts: 112, smsRevenueSek: 78.4, smsCostSek: 16.5, smsMarginSek: 61.9 },
    ],
    attention: { pastDue: [{ tenantId: "t1", name: "Pizzeria Roma", since: "2026-10-10T00:00:00Z", status: "active" }], noSubscription: [] },
    job: { finishedAt: "2026-10-21T04:35:00Z", warnings: [] },
    asOf: "2026-10-21T04:35:00Z",
    ...extra,
  };
}

function renderPage() {
  return render(<MemoryRouter><FinancePage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenants.mockResolvedValue(tenants);
  mocks.financeOverview.mockResolvedValue(overview());
});

describe("FinancePage", () => {
  it("shows the whole AWS bill, the part allocated to customers and the cost date", async () => {
    const base = overview();
    mocks.financeOverview.mockResolvedValue({
      ...base, costAsOf: "2026-10-20",
      kpis: { ...base.kpis, costSek: 140, costScope: "platform", allocatedCostSek: 100, unallocatedSek: 40,
              costSplitSek: { baseline: 60, requests: 80, email: 0, sms: 0 } },
    });
    renderPage();
    expect(await screen.findByText(/AWS cost known up to 20 okt/)).toBeInTheDocument();
    expect(screen.getAllByText("AWS bill").length).toBe(2);                       // hero fact and the tile
    expect(screen.getByText(/^100\skr allocated to customers, 40,00\skr not$/)).toBeInTheDocument();
    expect(screen.getByText("Allocated to customers")).toBeInTheDocument();
  });

  it("shows the key figures, the charts and the customers", async () => {
    renderPage();
    expect((await screen.findAllByText("2 980 kr")).length).toBeGreaterThan(0);   // MRR
    expect(screen.getAllByText("2 880 kr").length).toBeGreaterThan(0);             // revenue (tile and hero facts)
    expect(screen.getByText(/96,5 % of every krona invoiced stays as profit/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Where the revenue goes: Profit 96,5\s%, AWS cost 3,5\s%/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /How much is collected: Collected 33,2\s%/ })).toBeInTheDocument();
    expect(screen.getAllByText(/vs previous period/).length).toBeGreaterThan(0);
    expect(screen.getByText("412 parts charged, 61,50 kr AWS cost")).toBeInTheDocument();   // the SMS tile
    expect(mocks.financeOverview).toHaveBeenCalledTimes(2);                        // this period and the one before
    expect(screen.getByRole("img", { name: /Revenue and AWS cost per day/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Monthly recurring revenue/ })).toBeInTheDocument();
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Bistro Linnea")).toHaveAttribute("href", "/tenants/t2?tab=billing");
    expect(within(rows[1]).getByText("Past due")).toBeInTheDocument();
    expect(screen.getByText(/is past due since/)).toBeInTheDocument();
    expect(mocks.financeOverview).toHaveBeenLastCalledWith(expect.objectContaining({ includeInactive: false, tenantId: null }));
  });

  it("picks a billing period from the list, spans and the inactive toggle", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText("2 980 kr");
    const period = screen.getByLabelText("Billing period") as HTMLSelectElement;
    expect(period.options).toHaveLength(24);
    expect(period.options[0].textContent).toMatch(/\(now\)$/);
    expect(screen.queryByLabelText("From")).toBeNull();                 // no free date pickers any more
    await user.selectOptions(period, period.options[2].value);
    const picked = period.options[2].value;
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenCalledWith(expect.objectContaining({ from: picked })));
    await user.click(screen.getByRole("button", { name: "3 periods" }));
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: expect.any(String), from: expect.stringMatching(/-25$/) })));
    await user.click(screen.getByLabelText("Include inactive customers"));
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenLastCalledWith(expect.objectContaining({ includeInactive: true })));
  });

  it("filters to one customer by org number and clears again", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText("2 980 kr");
    await user.type(screen.getByLabelText("Filter by customer"), "556677");
    await user.click(await screen.findByRole("option", { name: /Pizzeria Roma/ }));
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: "t1" })));
    await user.click(screen.getByRole("button", { name: "Show all customers" }));
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: null })));
  });

  it("offers the customer's locations and scopes the figures to one", async () => {
    const user = userEvent.setup();
    mocks.financeOverview.mockImplementation(async (p: { tenantId?: string | null; locationId?: string | null }) => ({
      ...overview(), period: { ...overview().period, tenantId: p.tenantId ?? null, locationId: p.locationId ?? null, revenueScope: p.locationId ? "tenant" : null },
      locations: p.tenantId ? [{ locationId: "loc-1", name: "Södermalm" }, { locationId: "loc-2", name: "Vasastan" }] : [],
    }));
    renderPage();
    await screen.findAllByText("2 980 kr");
    expect(screen.queryByLabelText("Location")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Filter by customer"), "roma");
    await user.click(await screen.findByRole("option", { name: /Pizzeria Roma/ }));
    const select = await screen.findByLabelText("Location");
    await user.selectOptions(select, "loc-2");
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", locationId: "loc-2" })));
    expect(await screen.findByText(/Showing one location/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all customers" }));
    await waitFor(() => expect(screen.queryByLabelText("Location")).not.toBeInTheDocument());
  });

  it("sorts the table by a column", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findAllByText("2 980 kr");
    await user.click(screen.getByRole("button", { name: /^Bookings/ }));
    let rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Bistro Linnea")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Bookings/ }));
    rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Pizzeria Roma")).toBeInTheDocument();
  });

  it("explains an empty platform and job warnings", async () => {
    mocks.financeOverview.mockResolvedValue(overview({
      tenants: [], series: [], attention: { pastDue: [], noSubscription: [] },
      job: { finishedAt: "2026-10-21T04:35:00Z", warnings: ["Cost Explorer: not enabled"] },
      kpis: { ...overview().kpis, mrrSek: 0, revenueSek: 0, costSek: 0, marginSek: 0, marginPct: null, customers: 0, payingCustomers: 0 },
    }));
    renderPage();
    expect(await screen.findByText("Nothing to add up yet")).toBeInTheDocument();
    expect(screen.getByText("Cost Explorer: not enabled")).toBeInTheDocument();
    expect(screen.getAllByText("Nothing to draw yet.").length).toBeGreaterThan(0);
  });

  it("starts a rebuild for a range", async () => {
    const user = userEvent.setup();
    mocks.financeRebuild.mockResolvedValue({ from: "2026-10-01", to: "2026-10-20", status: "started" });
    renderPage();
    await screen.findAllByText("2 980 kr");
    await user.click(screen.getByRole("button", { name: "Rebuild" }));
    await user.click(screen.getByRole("button", { name: "Start rebuild" }));
    expect(await screen.findByText(/Rebuild started for 2026-10-01 to 2026-10-20/)).toBeInTheDocument();
    expect(mocks.financeRebuild).toHaveBeenCalledTimes(1);
  });

  it("switches to the Payments view: a month's invoices with reminders and fees", async () => {
    const user = userEvent.setup();
    mocks.financeInvoices.mockResolvedValue({
      period: { from: "2026-10-01", to: "2026-10-31", status: "all" },
      summary: { invoices: 2, paid: 1, open: 1, overdue: 1, invoicedSek: 2980, collectedSek: 1990, outstandingSek: 990,
                 overdueSek: 990, lateFeesSek: 450, interestSek: 0 },
      invoices: [
        { invoiceId: "in_x", number: "F-0003", status: "open", subtotalSek: 990, taxSek: 247.5, totalSek: 1237.5, amountPaidSek: 0,
          amountRemainingSek: 1237.5, outstandingSek: 990, dueDate: "2026-10-31T00:00:00Z", periodStart: "2026-10-01T00:00:00Z",
          periodEnd: "2026-11-01T00:00:00Z", paidOutOfBand: false, month: "2026-10", daysLate: 9, remindersSent: 2,
          lastReminderAt: "2026-11-08T05:00:00Z", lateFeeSek: 450, interestSek: null, collectionMethod: "send_invoice",
          tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", orgNumber: "556677-8899", tenantStatus: "active" },
        { invoiceId: "in_y", number: "F-0004", status: "paid", subtotalSek: 1990, taxSek: 497.5, totalSek: 2487.5, amountPaidSek: 2487.5,
          amountRemainingSek: 0, outstandingSek: 0, dueDate: "2026-10-31T00:00:00Z", paidAt: "2026-10-20T00:00:00Z",
          periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z", paidOutOfBand: true, month: "2026-10",
          daysLate: 0, remindersSent: 0, collectionMethod: "send_invoice",
          tenantId: "t2", name: "Bistro Linnea", slug: "linnea", orgNumber: "556000-0001", tenantStatus: "active" },
      ],
    });
    mocks.remindInvoice.mockResolvedValue({ remindersSent: 3 });
    renderPage();
    await screen.findAllByText("2 980 kr");
    await user.click(screen.getByRole("button", { name: "Payments" }));
    expect(await screen.findByText("1 of 2 paid")).toBeInTheDocument();
    expect(mocks.financeInvoices).toHaveBeenLastCalledWith(expect.objectContaining({ status: "all" }));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("9 d")).toBeInTheDocument();
    expect(within(rows[0]).getByText("2 sent")).toBeInTheDocument();
    expect(within(rows[1]).getByText(/bankgiro/)).toBeInTheDocument();
    await user.click(within(rows[0]).getByRole("button", { name: "Send reminder" }));
    await waitFor(() => expect(mocks.remindInvoice).toHaveBeenCalledWith("t1", "in_x"));
    await user.click(screen.getByRole("button", { name: /^Overdue/ }));
    await waitFor(() => expect(mocks.financeInvoices).toHaveBeenLastCalledWith(expect.objectContaining({ status: "overdue" })));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(mocks.financeInvoices).toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.stringMatching(/-01$/) })));
  });

  it("previews and runs the invoicing from the Payments view", async () => {
    const user = userEvent.setup();
    mocks.financeInvoices.mockResolvedValue({ period: { from: "2026-10-01", to: "2026-10-31", status: "all" },
      summary: { invoices: 0, paid: 0, open: 0, overdue: 0, invoicedSek: 0, collectedSek: 0, outstandingSek: 0, overdueSek: 0, lateFeesSek: 0, interestSek: 0 },
      invoices: [] });
    const line = { tenantId: "t1", name: "Pizzeria Roma", periodStart: "2026-08-25", periodEnd: "2026-09-24", period: "25 aug till 24 sep 2026",
                   days: 31, activeDays: 15, monthlySek: 990, feeSek: 479.03, feeText: "Booqy Starter, 25 aug till 24 sep 2026 (15 av 31 dagar)",
                   smsParts: 412, smsPriceSek: 0.7, smsSek: 288.4, smsText: "SMS ...", totalSek: 767.43, final: false };
    mocks.financeInvoicing.mockImplementation(async (dryRun: boolean) => ({
      dryRun, today: "2026-09-25", invoices: [dryRun ? line : { ...line, invoiceId: "in_1", number: "F-0001", delivery: "sent" }],
      skipped: [], errors: [], migrated: [], totalSek: 767.43 }));
    renderPage();
    await screen.findAllByText("2 980 kr");
    await user.click(screen.getByRole("button", { name: "Payments" }));
    await user.click(await screen.findByRole("button", { name: "Run invoicing" }));
    expect(await screen.findByText("25 aug till 24 sep 2026 (15 of 31 days)")).toBeInTheDocument();
    expect(mocks.financeInvoicing).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Create these invoices" }));
    await waitFor(() => expect(mocks.financeInvoicing).toHaveBeenCalledWith(false));
    expect(await screen.findByText("F-0001, sent")).toBeInTheDocument();
  });

  it("shows the API error", async () => {
    mocks.financeOverview.mockRejectedValue(new Error("The API didn't respond."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("The API didn't respond.");
  });
});
