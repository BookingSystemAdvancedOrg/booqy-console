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
    },
    series: [
      { day: "2026-10-01", invoicedSek: 2980, paidSek: 0, costSek: 60, mrrSek: 2980, bookings: 14, orders: 7, requests: 400, activeTenants: 2 },
      { day: "2026-10-02", invoicedSek: -100, paidSek: 990, costSek: 40, mrrSek: 2980, bookings: 9, orders: 4, requests: 250, activeTenants: 2 },
    ],
    tenants: [
      { tenantId: "t2", name: "Bistro Linnea", slug: "linnea", orgNumber: "556000-0001", status: "active", planId: "growth", billingStatus: "active",
        mrrSek: 1990, revenueSek: 1890, collectedSek: 0, creditedSek: 100, outstandingSek: 1990, costSek: 70,
        costSplitSek: { baseline: 10, requests: 60, email: 0, sms: 0 }, marginSek: 1820, marginPct: 96.3, bookings: 18, orders: 9,
        requests: 500, emails: 0, sms: 0, marketingEmails: 0, costPerBookingSek: 3.89, costPerOrderSek: 7.78, activeDays: 2, invoiceCount: 1 },
      { tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", orgNumber: "556677-8899", status: "active", planId: "starter", billingStatus: "past_due",
        pastDueSince: "2026-10-10T00:00:00Z", mrrSek: 990, revenueSek: 990, collectedSek: 990, creditedSek: 0, outstandingSek: 0, costSek: 30,
        costSplitSek: { baseline: 10, requests: 15, email: 5, sms: 0 }, marginSek: 960, marginPct: 97, bookings: 5, orders: 2,
        requests: 150, emails: 5, sms: 0, marketingEmails: 0, costPerBookingSek: 6, costPerOrderSek: 15, activeDays: 2, invoiceCount: 1 },
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
  it("shows the key figures, the charts and the customers", async () => {
    renderPage();
    expect(await screen.findByText("2 980 kr")).toBeInTheDocument();     // MRR
    expect(screen.getByText("2 880 kr")).toBeInTheDocument();            // revenue
    expect(screen.getByText("96,5 % of revenue")).toBeInTheDocument();
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

  it("asks for the period preset and the inactive toggle", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("2 980 kr");
    await user.click(screen.getByRole("button", { name: "This year" }));
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: `${new Date().getFullYear()}-01-01` })));
    await user.click(screen.getByLabelText("Include inactive customers"));
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenLastCalledWith(expect.objectContaining({ includeInactive: true })));
  });

  it("filters to one customer by org number and clears again", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("2 980 kr");
    await user.type(screen.getByLabelText("Filter by customer"), "556677");
    await user.click(await screen.findByRole("option", { name: /Pizzeria Roma/ }));
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: "t1" })));
    await user.click(screen.getByRole("button", { name: "Show all customers" }));
    await waitFor(() => expect(mocks.financeOverview).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: null })));
  });

  it("sorts the table by a column", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("2 980 kr");
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
    await screen.findByText("2 980 kr");
    await user.click(screen.getByRole("button", { name: "Rebuild" }));
    await user.click(screen.getByRole("button", { name: "Start rebuild" }));
    expect(await screen.findByText(/Rebuild started for 2026-10-01 to 2026-10-20/)).toBeInTheDocument();
    expect(mocks.financeRebuild).toHaveBeenCalledTimes(1);
  });

  it("shows the API error", async () => {
    mocks.financeOverview.mockRejectedValue(new Error("The API didn't respond."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("The API didn't respond.");
  });
});
