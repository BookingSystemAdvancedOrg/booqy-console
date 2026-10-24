import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Billing, BillingView, Tenant } from "../types";
import { endDateFor, periodOf, isoDay, addDays } from "../finance";

const mocks = vi.hoisted(() => ({
  billing: vi.fn(), startSubscription: vi.fn(), updateSubscription: vi.fn(), cardLink: vi.fn(), remindInvoice: vi.fn(), invoiceNow: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import BillingTab from "./BillingTab";

const tenant: Tenant = {
  tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", status: "active", planId: "starter",
  entitlements: { maxLocations: 1, features: {} }, locationCount: 1, legalName: "Roma Restaurang AB", ownerEmail: "owner@roma.se",
};
const today = isoDay(new Date());
const { start, end } = periodOf(today);

function billing(extra: Partial<Billing> = {}): BillingView {
  return {
    billing: {
      status: "none", subscribed: false, terms: "trial", monthlySek: 990, smsPrice: 0.7, smsPriceDefaultSek: 0.7,
      collectionMethod: "send_invoice", hasCard: false, autoSuspended: false, offboardAtEnd: false, noticeMonths: 3, trialMonths: 6,
      daysUntilDue: 30, suspendAfterDays: 14, plan: { planId: "starter", name: "Starter", priceSek: 990 },
      nextInvoice: null, pendingPeriods: 0, ...extra,
    } as Billing,
    invoices: [],
  };
}

const running = (extra: Partial<Billing> = {}) => billing({
  status: "active", subscribed: true, customerId: "cus_1", startsAt: "2026-09-10", termsSince: "2026-09-10T00:00:00Z",
  trialEndsAt: "2027-03-10T00:00:00Z",
  nextInvoice: { periodStart: start, periodEnd: end, period: "25 sep till 24 okt 2026", days: 30, activeDays: 30, monthlySek: 990,
                 feeSek: 990, feeText: "Booqy Starter, 25 sep till 24 okt 2026", smsParts: 412, smsPriceSek: 0.7, smsSek: 288.4,
                 smsText: "SMS 25 sep till 24 okt 2026: 412 delar x 0,70 kr (Södermalm 300, Vasastan 112)",
                 smsByLocation: { "Södermalm": 300, Vasastan: 112 }, totalSek: 1278.4, final: false,
                 date: addDays(end, 1), dueDate: addDays(end, 31), smsSoFar: true },
  ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe("BillingTab", () => {
  it("starts an agreement with terms, own price and the start date", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(billing());
    mocks.startSubscription.mockResolvedValue({ billing: running().billing });
    const onChanged = vi.fn();
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={onChanged} />);
    expect(await screen.findByText("No agreement")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start agreement" }));
    expect(screen.getByText(/Nothing is charged now/)).toBeInTheDocument();
    await user.click(screen.getByText("Subscription", { selector: "strong" }));
    const priceInput = screen.getByLabelText(/Monthly price/);
    await user.clear(priceInput);
    await user.type(priceInput, "790");
    await user.click(screen.getAllByRole("button", { name: "Start agreement" }).at(-1)!);
    await waitFor(() => expect(mocks.startSubscription).toHaveBeenCalledWith("t1", {
      collectionMethod: "send_invoice", startDate: today, terms: "subscription", priceSek: 790 }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows a running try-out with the next invoice and converts it", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(running());
    mocks.updateSubscription.mockResolvedValue({ billing: running({ terms: "subscription" }).billing });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Try-out period since 10 sep/)).toBeInTheDocument();
    expect(screen.getByText(/Next invoice:/)).toBeInTheDocument();
    expect(screen.getByText("Booqy Starter, 25 sep till 24 okt 2026")).toBeInTheDocument();
    expect(screen.getByText(/412 delar x 0,70 kr/)).toBeInTheDocument();
    expect(screen.getByText(/SMS per location: Södermalm 300, Vasastan 112/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Convert to subscription" }));
    await waitFor(() => expect(mocks.updateSubscription).toHaveBeenCalledWith("t1", "convert", {}));
  });

  it("cancels with the end date per the terms and can keep the agreement", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(running({ terms: "subscription", trialEndsAt: null }));
    mocks.updateSubscription.mockResolvedValue({ billing: running().billing });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    await screen.findByText(/Subscription, 3 months' notice/);
    await user.click(screen.getByRole("button", { name: "Cancel agreement" }));
    const ends = endDateFor("subscription", 3);
    const label = new RegExp(`End on ${new Date(ends).getDate()}`);
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Offboard the customer automatically/));
    await user.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(mocks.updateSubscription).toHaveBeenCalledWith("t1", "cancel", { offboardAtEnd: false }));
  });

  it("offers to keep a cancelled agreement and to invoice pending periods", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(running({ status: "ending", endsAt: "2027-01-24", offboardAtEnd: true, pendingPeriods: 2 }));
    mocks.updateSubscription.mockResolvedValue({ billing: running().billing });
    mocks.invoiceNow.mockResolvedValue({ dryRun: false, today, invoices: [{ tenantId: "t1", name: "Pizzeria Roma", totalSek: 990 }], skipped: [], errors: [], migrated: [], totalSek: 990 });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText(/ends on 24 jan/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel agreement" })).not.toBeInTheDocument();
    expect(screen.getByText(/2 complete periods are/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Invoice now" }));
    await waitFor(() => expect(mocks.invoiceNow).toHaveBeenCalledWith("t1"));
    expect(await screen.findByText(/1 invoice created/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep the agreement" }));
    await waitFor(() => expect(mocks.updateSubscription).toHaveBeenCalledWith("t1", "keep", {}));
  });

  it("starts a new agreement after one has ended, from the day after it ended", async () => {
    const user = userEvent.setup();
    const endedOn = addDays(today, -5);
    mocks.billing.mockResolvedValue(running({ status: "ending", endsAt: endedOn,
                                              previous: [{ startsAt: "2026-06-01", endsAt: "2026-06-10" }] }));
    mocks.startSubscription.mockResolvedValue({ billing: running().billing });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText(/The agreement ended on/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep the agreement" })).not.toBeInTheDocument();
    expect(screen.getByText(/on the next invoice$/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start a new agreement" }));
    expect(screen.getByText(/goes on the same invoice/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Start agreement" }).at(-1)!);
    await waitFor(() => expect(mocks.startSubscription).toHaveBeenCalledWith("t1", expect.objectContaining({ startDate: today })));
  });

  it("changes the SMS price", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(running());
    mocks.updateSubscription.mockResolvedValue({ billing: running({ smsPriceSek: 0.55, smsPrice: 0.55 }).billing });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    await screen.findByText(/0,70 kr per part ex VAT/);
    await user.click(screen.getByRole("button", { name: "Change" }));
    const input = screen.getByLabelText("Price per SMS part");
    await user.clear(input);
    await user.type(input, "0.55");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.updateSubscription).toHaveBeenCalledWith("t1", "set_sms_price", { smsPriceSek: 0.55 }));
  });

  it("lists invoices with their period, fee and SMS lines and a reminder button", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue({
      ...running(),
      invoices: [{ invoiceId: "in_1", number: "F-0001", status: "open", subtotalSek: 1278.4, taxSek: 319.6, totalSek: 1598,
                   amountPaidSek: 0, amountRemainingSek: 1598, outstandingSek: 1278.4, dueDate: "2026-10-01T00:00:00Z",
                   periodStart: "2026-08-25", periodEnd: "2026-09-24", hostedInvoiceUrl: "https://invoice.stripe.com/x",
                   paidOutOfBand: false, daysLate: 12, remindersSent: 1, lateFeeSek: 450, interestSek: null, collectionMethod: "send_invoice",
                   feeSek: 990, smsParts: 412, smsSek: 288.4 }],
    });
    mocks.remindInvoice.mockResolvedValue({ remindersSent: 2 });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText("F-0001")).toBeInTheDocument();
    expect(screen.getByText("25 aug. to 24 sep.")).toBeInTheDocument();
    expect(screen.getByText(/412 parts, 288,40 kr/)).toBeInTheDocument();
    expect(screen.getByText("12 days")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send reminder" }));
    await waitFor(() => expect(mocks.remindInvoice).toHaveBeenCalledWith("t1", "in_1"));
  });

  it("cannot start for a customer that is not active or a plan without a price", async () => {
    mocks.billing.mockResolvedValue(billing({ plan: { planId: "starter", name: "Starter", priceSek: null } }));
    render(<BillingTab tenant={{ ...tenant, status: "suspended" }} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByRole("button", { name: "Start agreement" })).toBeDisabled();
    expect(screen.getByText(/has no price yet/)).toBeInTheDocument();
  });
});
