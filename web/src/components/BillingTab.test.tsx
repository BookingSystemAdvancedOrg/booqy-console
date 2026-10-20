import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Billing, BillingView, Tenant } from "../types";

const mocks = vi.hoisted(() => ({
  billing: vi.fn(), startSubscription: vi.fn(), updateSubscription: vi.fn(), cardLink: vi.fn(), remindInvoice: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import BillingTab from "./BillingTab";

const tenant: Tenant = {
  tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", status: "active", planId: "starter",
  entitlements: { maxLocations: 1, features: {} }, locationCount: 1, legalName: "Roma Restaurang AB", ownerEmail: "owner@roma.se",
};

function billing(extra: Partial<Billing> = {}): BillingView {
  return {
    billing: {
      pauseCollection: false, autoSuspended: false, hasCard: false, subscribed: false, priceDiffers: false,
      daysUntilDue: 30, suspendAfterDays: 14, terms: "trial", monthlySek: 990, noticeMonths: 3, trialMonths: 6, offboardAtEnd: false,
      plan: { planId: "starter", name: "Starter", priceSek: 990, stripePriceId: "price_starter" }, ...extra,
    } as Billing,
    invoices: [],
  };
}

beforeEach(() => vi.clearAllMocks());

describe("BillingTab", () => {
  it("offers to start a subscription and sends the chosen method and date", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(billing());
    mocks.startSubscription.mockResolvedValue({ billing: billing({ subscribed: true, status: "active" }).billing });
    const onChanged = vi.fn();
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={onChanged} />);
    expect(await screen.findByText("No subscription")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start subscription" }));
    expect(screen.getByText(/990 kr per month excluding VAT/)).toBeInTheDocument();
    await user.click(screen.getByText("Charge a card on file"));
    await user.click(screen.getByText("Subscription", { selector: "strong" }));
    const priceInput = screen.getByLabelText(/Monthly price/);
    await user.clear(priceInput);
    await user.type(priceInput, "790");
    await user.type(screen.getByLabelText(/First invoice date/), "2030-01-01");
    await user.click(screen.getAllByRole("button", { name: "Start subscription" }).at(-1)!);
    await waitFor(() => expect(mocks.startSubscription).toHaveBeenCalledWith("t1", {
      collectionMethod: "charge_automatically", startDate: "2030-01-01", terms: "subscription", priceSek: 790 }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows a running subscription with its actions and invoices", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue({
      ...billing({ subscribed: true, status: "active", subscriptionId: "sub_1", customerId: "cus_1", mrrSek: 990,
                   collectionMethod: "send_invoice", currentPeriodStart: "2026-10-01T00:00:00Z", currentPeriodEnd: "2026-11-01T00:00:00Z",
                   priceDiffers: true, terms: "subscription", termsSince: "2026-06-02T00:00:00Z" }),
      invoices: [{ invoiceId: "in_1", number: "F-0001", status: "open", subtotalSek: 990, taxSek: 247.5, totalSek: 1237.5,
                   amountPaidSek: 0, amountRemainingSek: 1237.5, outstandingSek: 990, dueDate: "2026-10-01T00:00:00Z",
                   periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", hostedInvoiceUrl: "https://invoice.stripe.com/x",
                   paidOutOfBand: false, daysLate: 12, remindersSent: 1, lateFeeSek: 450, interestSek: null, collectionMethod: "send_invoice" }],
    });
    mocks.updateSubscription.mockResolvedValue({ billing: billing().billing });
    mocks.remindInvoice.mockResolvedValue({ remindersSent: 2 });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.getByText("F-0001")).toBeInTheDocument();
    expect(screen.getByText("12 days")).toBeInTheDocument();
    expect(screen.getByText("1 reminder")).toBeInTheDocument();
    expect(screen.getByText(/450,00 kr fees/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send reminder" }));
    await waitFor(() => expect(mocks.remindInvoice).toHaveBeenCalledWith("t1", "in_1"));
    expect(screen.getByText("Open", { selector: ".status" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "https://invoice.stripe.com/x");
    expect(screen.getByText(/The plan's price changed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause invoicing" }));
    await waitFor(() => expect(mocks.updateSubscription).toHaveBeenCalledWith("t1", "pause", {}));
    expect(screen.getByText(/Subscription, 3 months' notice/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel subscription" }));
    // 3 months after the paid month ends (1 Nov) = 1 Feb
    expect(screen.getByRole("button", { name: /End on 1 feb/ })).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Offboard the customer automatically/));
    await user.click(screen.getByRole("button", { name: /End on 1 feb/ }));
    await waitFor(() => expect(mocks.updateSubscription).toHaveBeenCalledWith("t1", "cancel", { offboardAtEnd: false }));
  });

  it("shows a try-out's terms and converts it", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(billing({ subscribed: true, status: "active", subscriptionId: "sub_1", customerId: "cus_1", mrrSek: 790,
      priceSek: 790, monthlySek: 790, terms: "trial", termsSince: "2026-06-02T00:00:00Z", trialEndsAt: "2026-12-02T00:00:00Z",
      currentPeriodEnd: "2026-11-01T00:00:00Z" }));
    mocks.updateSubscription.mockResolvedValue({ billing: billing().billing });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText(/Try-out period since 2 juni/)).toBeInTheDocument();
    expect(screen.getByText(/790 kr per month ex VAT \(own price\)/)).toBeInTheDocument();
    expect(screen.getByText(/becomes a subscription on 2 dec/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel subscription" }));
    expect(screen.getByText(/ends with the paid month/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /End on 1 nov/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    await user.click(screen.getByRole("button", { name: "Convert to subscription" }));
    await waitFor(() => expect(mocks.updateSubscription).toHaveBeenCalledWith("t1", "convert", {}));
  });

  it("offers to keep a cancelled subscription", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(billing({ subscribed: true, status: "active", subscriptionId: "sub_1", customerId: "cus_1",
      terms: "subscription", endsAt: "2027-02-01T00:00:00Z", offboardAtEnd: true, currentPeriodEnd: "2026-11-01T00:00:00Z" }));
    mocks.updateSubscription.mockResolvedValue({ billing: billing().billing });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText(/ends on 1 feb/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep the subscription" }));
    await waitFor(() => expect(mocks.updateSubscription).toHaveBeenCalledWith("t1", "keep", {}));
  });

  it("creates a card link", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(billing());
    mocks.cardLink.mockResolvedValue({ url: "https://checkout.stripe.com/c/cs_1" });
    render(<BillingTab tenant={tenant} cardParam="added" onChanged={() => {}} />);
    await screen.findByText("No subscription");
    expect(screen.getByText(/The card was added in Stripe/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create card link" }));
    expect(await screen.findByDisplayValue("https://checkout.stripe.com/c/cs_1")).toBeInTheDocument();
  });

  it("cannot start for a customer that is not active or a plan without a price", async () => {
    mocks.billing.mockResolvedValue(billing({ plan: { planId: "starter", name: "Starter" } }));
    render(<BillingTab tenant={{ ...tenant, status: "suspended" }} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByRole("button", { name: "Start subscription" })).toBeDisabled();
    expect(screen.getByText(/has no Stripe price yet/)).toBeInTheDocument();
  });
});
