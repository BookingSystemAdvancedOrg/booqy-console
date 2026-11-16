import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentsView as Payments } from "../types";

const mocks = vi.hoisted(() => ({
  financeInvoices: vi.fn(),
  remindInvoice: vi.fn(),
  financeInvoicing: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import PaymentsView from "./PaymentsView";

const summary: Payments["summary"] = {
  invoices: 5, paid: 3, open: 2, overdue: 1, invoicedSek: 4950, collectedSek: 2970, outstandingSek: 1980,
  overdueSek: 990, lateFeesSek: 0, interestSek: 0,
};
const empty = (status = "all"): Payments => ({ period: { from: "2026-10-01", to: "2026-10-31", status }, summary, invoices: [] });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.financeInvoices.mockImplementation(async (p: { status: string }) => empty(p.status));
});

function renderView() {
  return render(<MemoryRouter><PaymentsView /></MemoryRouter>);
}

describe("PaymentsView", () => {
  it("keeps every chip count and the paid KPI for the whole month when a status chip is picked", async () => {
    const user = userEvent.setup();
    renderView();
    expect(await screen.findByText("3 of 5 paid")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Paid/ }));
    await waitFor(() => expect(mocks.financeInvoices).toHaveBeenLastCalledWith(expect.objectContaining({ status: "paid" })));
    expect(await screen.findByText("3 of 5 paid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Open/ })).toHaveTextContent("Open2");
    expect(screen.getByRole("button", { name: /^Overdue/ })).toHaveTextContent("Overdue1");
  });

  it("offers Try again after a failed first load and reloads the list", async () => {
    const user = userEvent.setup();
    mocks.financeInvoices.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderView();
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("3 of 5 paid")).toBeInTheDocument();
    expect(mocks.financeInvoices).toHaveBeenCalledTimes(2);
  });

  it("says invoices are created on the 1st, not by Stripe", async () => {
    const none = { ...summary, invoices: 0, paid: 0, open: 0, overdue: 0, invoicedSek: 0, collectedSek: 0, outstandingSek: 0, overdueSek: 0 };
    mocks.financeInvoices.mockImplementation(async (p: { status: string }) => ({ ...empty(p.status), summary: none }));
    renderView();
    expect(await screen.findByText(/They are created on the 1st\./)).toBeInTheDocument();
    expect(screen.queryByText(/Stripe/)).not.toBeInTheDocument();
  });

  it("does not say invoices are created on the 1st when only the status chip empties the list", async () => {
    const user = userEvent.setup();
    renderView();
    expect(await screen.findByText("3 of 5 paid")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Overdue/ }));
    expect(await screen.findByText(/^No invoices for .+ with status overdue\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/They are created on the 1st/)).not.toBeInTheDocument();
  });

  it("describes the invoicing run in monthly terms", async () => {
    const user = userEvent.setup();
    mocks.financeInvoicing.mockResolvedValue({ dryRun: true, today: "2026-10-01", invoices: [], skipped: [], errors: [],
      migrated: [{ tenantId: "t1" }], totalSek: 0 });
    renderView();
    await user.click(await screen.findByRole("button", { name: "Run invoicing" }));
    expect(await screen.findByText("Nothing to invoice: every month is already invoiced.")).toBeInTheDocument();
    expect(screen.getByText(/1 legacy subscription moved to monthly invoicing/)).toBeInTheDocument();
    expect(screen.queryByText(/arrears/)).not.toBeInTheDocument();
  });

  it("keeps an org number on one line", async () => {
    mocks.financeInvoices.mockResolvedValue({ ...empty(), invoices: [
      { invoiceId: "in_x", number: "F-0003", status: "open", subtotalSek: 990, taxSek: 247.5, totalSek: 1237.5, amountPaidSek: 0,
        amountRemainingSek: 1237.5, outstandingSek: 990, dueDate: "2026-10-31T00:00:00Z", periodStart: "2026-10-01T00:00:00Z",
        periodEnd: "2026-11-01T00:00:00Z", paidOutOfBand: false, month: "2026-10", daysLate: 0, remindersSent: 0,
        lateFeeSek: 0, interestSek: null, collectionMethod: "send_invoice",
        tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", orgNumber: "556677-8899", tenantStatus: "active" },
    ] });
    renderView();
    expect(await screen.findByText("556677-8899")).toHaveClass("finance-org");
  });
});
