import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Billing, BillingView, Invoice, Tenant } from "../types";
import { endDateFor, monthOf, isoDay, addDays } from "../finance";

const mocks = vi.hoisted(() => ({
  billing: vi.fn(), startSubscription: vi.fn(), updateSubscription: vi.fn(), cardLink: vi.fn(), remindInvoice: vi.fn(), invoiceNow: vi.fn(), creditNotes: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({ api: mocks, ApiError: (await importOriginal<typeof import("../api")>()).ApiError }));

import BillingTab from "./BillingTab";

const tenant: Tenant = {
  tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", status: "active", planId: "starter",
  entitlements: { maxLocations: 1, features: {} }, locationCount: 1, legalName: "Roma Restaurang AB", ownerEmail: "owner@roma.se",
};
const today = isoDay(new Date());
const { start, end } = monthOf(today);

function billing(extra: Partial<Billing> = {}): BillingView {
  return {
    billing: {
      status: "none", subscribed: false, terms: "trial", monthlySek: 990, free: null,
      collectionMethod: "send_invoice", collectionPreference: "card", hasCard: false, cycle: "advance", autoSuspended: false, offboardAtEnd: false, noticeMonths: 3, trialMonths: 6,
      daysUntilDue: 10, suspendAfterDays: 0, reminderSteps: [3, 7, 14], finalNoticeDays: 30, sellerMissing: [], plan: { planId: "starter", name: "Starter", priceSek: 990 },
      nextInvoice: null, pendingPeriods: 0, ...extra,
    } as Billing,
    invoices: [],
  };
}

const running = (extra: Partial<Billing> = {}) => billing({
  status: "active", subscribed: true, customerId: "cus_1", startsAt: "2026-09-10", termsSince: "2026-09-10T00:00:00Z",
  trialEndsAt: "2027-03-10T00:00:00Z",
  nextInvoice: { periodStart: start, periodEnd: end, period: "1 dec till 31 dec 2026", days: 31, activeDays: 31, billedDays: 31,
                 monthlySek: 990, feeSek: 990, feeText: "Booqy Starter, 1 dec till 31 dec 2026", totalSek: 990, final: false,
                 date: addDays(end, 1), dueDate: addDays(end, 11), kind: "advance" },
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
    expect(screen.getByText(/Billed in advance/)).toBeInTheDocument();
    expect(screen.getByText(/First invoice on .*then on the 1st of every month, in advance/)).toBeInTheDocument();
    await user.click(screen.getByText("Subscription", { selector: "strong" }));
    const priceInput = screen.getByLabelText(/Monthly price/);
    await user.clear(priceInput);
    await user.type(priceInput, "790");
    await user.click(screen.getAllByRole("button", { name: "Start agreement" }).at(-1)!);
    await waitFor(() => expect(mocks.startSubscription).toHaveBeenCalledWith("t1", {
      collectionPreference: "card", startDate: today, terms: "subscription", priceSek: 790 }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows a running try-out with the next invoice and converts it", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue(running());
    mocks.updateSubscription.mockResolvedValue({ billing: running({ terms: "subscription" }).billing });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/Try-out period since 10 Sept/)).toBeInTheDocument();
    expect(screen.getByText(/Next invoice:/)).toBeInTheDocument();
    expect(screen.getByText("Booqy Starter, 1 dec till 31 dec 2026")).toBeInTheDocument();
    // SMS are included in the price: no SMS line, no SMS price
    expect(screen.queryByText(/delar x/)).not.toBeInTheDocument();
    expect(screen.queryByText(/SMS per location/)).not.toBeInTheDocument();
    expect(screen.getByText("Included in the price")).toBeInTheDocument();
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
    expect(await screen.findByText(/ends on 24 Jan/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel agreement" })).not.toBeInTheDocument();
    expect(screen.getByText(/2 months are/)).toBeInTheDocument();
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
    expect(screen.getByText(/earlier agreement .* already paid are not charged again/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Start agreement" }).at(-1)!);
    await waitFor(() => expect(mocks.startSubscription).toHaveBeenCalledWith("t1", expect.objectContaining({ startDate: today })));
  });

  it("has no SMS price to change", async () => {
    mocks.billing.mockResolvedValue(running());
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    await screen.findByText("Included in the price");
    expect(screen.queryByLabelText("Price per SMS part")).not.toBeInTheDocument();
    expect(screen.queryByText(/per part/)).not.toBeInTheDocument();
  });

  it("shows the Free plan's period and charges nothing", async () => {
    mocks.billing.mockResolvedValue(running({
      monthlySek: 0, plan: { planId: "free", name: "Free", priceSek: 0, free: true },
      free: { until: "2027-02-14", switchOn: "2027-02-15", thenPlanId: "starter", thenPlanName: "Starter", thenPriceSek: 990 },
    }));
    render(<BillingTab tenant={{ ...tenant, planId: "free" }} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText("Nothing (Free)")).toBeInTheDocument();
    expect(screen.getByText(/Until 14 Feb 2027, then Starter \(990 kr per month\) from 15 Feb 2027/)).toBeInTheDocument();
  });

  it("shows Free without an end date", async () => {
    mocks.billing.mockResolvedValue(billing({ monthlySek: 0, plan: { planId: "free", name: "Free", priceSek: 0, free: true },
                                              free: { until: null, thenPlanId: "starter" } }));
    render(<BillingTab tenant={{ ...tenant, planId: "free" }} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText(/No end date: free until the plan is changed/)).toBeInTheDocument();
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
    expect(screen.getByText("25 Aug to 24 Sept")).toBeInTheDocument();
    expect(screen.getByText(/412 parts, 288,40 kr/)).toBeInTheDocument();
    expect(screen.getByText("12 days")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send reminder" }));
    await waitFor(() => expect(mocks.remindInvoice).toHaveBeenCalledWith("t1", "in_1"));
  });

  it("shows no SMS column for invoices without an SMS line", async () => {
    mocks.billing.mockResolvedValue({
      ...running(),
      invoices: [{ invoiceId: "in_2", number: "F-0002", status: "paid", subtotalSek: 990, taxSek: 247.5, totalSek: 1237.5,
                   amountPaidSek: 1237.5, amountRemainingSek: 0, outstandingSek: 0, periodStart: "2026-10-25", periodEnd: "2026-11-24",
                   paidOutOfBand: false, daysLate: 0, remindersSent: 0, feeSek: 990 }],
    });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText("F-0002")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "SMS" })).not.toBeInTheDocument();
  });

  it("chooses card or invoice, shows the card and flags overdue invoices", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue({
      ...running({ hasCard: true, cardBrand: "visa", cardLast4: "4242", collectionMethod: "charge_automatically",
                   billingEmail: "faktura@roma.se" }),
      invoices: [{ invoiceId: "in_9", number: "F-0009", status: "open", subtotalSek: 990, taxSek: 247.5, totalSek: 1237.5,
                   amountPaidSek: 0, amountRemainingSek: 1237.5, outstandingSek: 990, periodStart: "2026-11-01", periodEnd: "2026-11-30",
                   paidOutOfBand: false, daysLate: 8, remindersSent: 1, reminderStep: 7, kind: "advance",
                   collectionMethod: "charge_automatically" }],
    });
    mocks.updateSubscription.mockResolvedValue({ billing: running().billing });
    render(<BillingTab tenant={tenant} cardParam="added" onChanged={() => {}} />);
    expect(await screen.findByTestId("overdue-badge")).toHaveTextContent("1 overdue");
    expect(screen.getByText(/One invoice is overdue, the oldest 8 days/)).toBeInTheDocument();
    expect(screen.getByText(/VISA ending 4242/)).toBeInTheDocument();
    expect(screen.getByText("faktura@roma.se")).toBeInTheDocument();
    expect(screen.getByText("reminder at day 7")).toBeInTheDocument();
    expect(screen.getByText(/becomes the default by itself/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Collection" }));
    await user.click(screen.getByRole("option", { name: "Invoice (pay within 30 days)" }));
    await waitFor(() => expect(mocks.updateSubscription).toHaveBeenCalledWith("t1", "collection", { collectionPreference: "invoice" }));
  });

  it("cannot start for a customer that is not active or a plan without a price", async () => {
    mocks.billing.mockResolvedValue(billing({ plan: { planId: "starter", name: "Starter", priceSek: null } }));
    render(<BillingTab tenant={{ ...tenant, status: "suspended" }} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByRole("button", { name: "Start agreement" })).toBeDisabled();
    expect(screen.getByText(/has no price yet/)).toBeInTheDocument();
  });
});

describe("BillingTab when the first load fails (finding 180)", () => {
  it("offers Try again, which loads it", async () => {
    mocks.billing.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(billing());
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No agreement")).toBeInTheDocument();
    expect(mocks.billing).toHaveBeenCalledTimes(2);
  });

  it("loads again when the page's Refresh is pressed", async () => {
    mocks.billing.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(billing());
    const { rerender } = render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} refreshed={0} />);
    await screen.findByRole("button", { name: "Try again" });
    rerender(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} refreshed={1} />);
    expect(await screen.findByText("No agreement")).toBeInTheDocument();
  });
});

describe("BillingTab refunds and credits", () => {
  const paid = (id: string, number: string, extra: Partial<Invoice> = {}): Invoice => ({
    invoiceId: id, number, status: "paid", subtotalSek: 1000, taxSek: 250, totalSek: 1250, amountPaidSek: 1250,
    amountRemainingSek: 0, outstandingSek: 0, periodStart: "2026-10-01", periodEnd: "2026-10-31", paidOutOfBand: false,
    daysLate: 0, remindersSent: 0, kind: "advance", refundedSek: 0, creditedSek: 0, creditableSek: 1250, refundable: true, ...extra,
  });
  const invoices = [
    paid("in_a", "F-0010"),
    paid("in_b", "F-0011", { refundedSek: 250, creditableSek: 1000 }),
    paid("in_c", "F-0012", { refundedSek: 1250, creditableSek: 0 }),
    paid("in_d", "F-0013", { creditedSek: 100, creditableSek: 1150 }),
  ];

  it("shows the refunded, partly refunded and credited status and ticks only what is left", async () => {
    mocks.billing.mockResolvedValue({ ...running(), invoices });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    expect(await screen.findByText("Refunded")).toBeInTheDocument();
    expect(screen.getByText("Partly refunded")).toBeInTheDocument();
    expect(screen.getByText("Credited")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pick invoice F-0010" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Pick invoice F-0012" })).not.toBeInTheDocument();
  });

  it("totals the ticked invoices and refunds them with one request id", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue({ ...running(), invoices });
    mocks.creditNotes.mockResolvedValue({ results: [
      { invoiceId: "in_a", ok: true, creditNoteId: "cn_1", totalSek: 12.5, refundedSek: 12.5, creditedSek: 0 },
      { invoiceId: "in_b", ok: true, creditNoteId: "cn_2", totalSek: 1000, refundedSek: 1000, creditedSek: 0 },
    ], ok: 2, failed: 0, refundedSek: 1012.5, creditedSek: 0 });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    await user.click(await screen.findByRole("checkbox", { name: "Pick invoice F-0010" }));
    await user.click(screen.getByRole("checkbox", { name: "Pick invoice F-0011" }));
    const bar = screen.getByRole("button", { name: /Refund or credit \(2\)/ });
    expect(bar).toHaveTextContent(/2[\s\u00a0]250,00 kr/);
    await user.click(bar);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "Back to the card" })).toHaveAttribute("aria-checked", "true");
    const amount = within(dialog).getByRole("textbox", { name: "Amount for F-0010, incl VAT" });
    await user.clear(amount);
    await user.type(amount, "99999");
    expect(within(dialog).getByText(/At most 1[\s\u00a0]250,00 kr/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Refund / })).toBeDisabled();
    await user.tab();                                  // capped on leaving the field
    expect(amount).toHaveValue("1250,00");
    await user.clear(amount);
    await user.type(amount, "12,50");
    expect(within(dialog).getByRole("button", { name: /^Refund 1[\s\u00a0]012,50 kr$/ })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: /^Refund 1[\s\u00a0]012,50 kr$/ }));
    await waitFor(() => expect(mocks.creditNotes).toHaveBeenCalledTimes(1));
    const [id, body] = mocks.creditNotes.mock.calls[0];
    expect(id).toBe("t1");
    expect(body).toMatchObject({ method: "refund", reason: "other",
                                 items: [{ invoiceId: "in_a", amountSek: "12.50" }, { invoiceId: "in_b", amountSek: "1000.00" }] });
    expect(body.requestId).toEqual(expect.any(String));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(mocks.billing).toHaveBeenCalledTimes(2));      // reloaded: the rows show the new status
    expect(screen.queryByRole("button", { name: /Refund or credit/ })).not.toBeInTheDocument();
  });

  it("keeps a failed invoice in the dialog with its reason and retries it as a new attempt of the same request", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue({ ...running(), invoices });
    mocks.creditNotes.mockResolvedValueOnce({ results: [
      { invoiceId: "in_a", ok: true, creditNoteId: "cn_1", totalSek: 1250, refundedSek: 0, creditedSek: 1250 },
      { invoiceId: "in_d", ok: false, error: "stripe_error", message: "Stripe: try later" },
    ], ok: 1, failed: 1, refundedSek: 0, creditedSek: 1250 }).mockResolvedValueOnce({ results: [
      { invoiceId: "in_d", ok: true, creditNoteId: "cn_2", totalSek: 1150, refundedSek: 0, creditedSek: 1150 },
    ], ok: 1, failed: 0, refundedSek: 0, creditedSek: 1150 });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    await user.click(await screen.findByRole("checkbox", { name: "Pick invoice F-0010" }));
    await user.click(screen.getByRole("checkbox", { name: "Pick invoice F-0013" }));
    await user.click(screen.getByRole("button", { name: /Refund or credit \(2\)/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Credit next invoice" }));
    await user.click(within(dialog).getByRole("button", { name: /^Credit 2[\s\u00a0]400,00 kr$/ }));
    expect(await within(dialog).findByText("Stripe: try later")).toBeInTheDocument();
    expect(within(dialog).queryByText("F-0010")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^Credit 1[\s\u00a0]150,00 kr$/ }));
    await waitFor(() => expect(mocks.creditNotes).toHaveBeenCalledTimes(2));
    const [[, first], [, second]] = mocks.creditNotes.mock.calls;
    expect(second.requestId).toBe(first.requestId);
    expect(first.items).toEqual([{ invoiceId: "in_a", amountSek: "1250.00" }, { invoiceId: "in_d", amountSek: "1150.00" }]);
    // a new attempt: Stripe answers a key it saw fail with the same failure for 24 h
    expect(second.items).toEqual([{ invoiceId: "in_d", amountSek: "1150.00", attempt: 1 }]);
    expect(second.method).toBe("credit");
  });

  it("only credits when an invoice is open or paid outside Stripe", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue({ ...running(), invoices: [
      paid("in_o", "F-0020", { status: "open", amountPaidSek: 0, amountRemainingSek: 1250, creditableSek: 1250, refundable: false }),
    ] });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    await user.click(await screen.findByRole("checkbox", { name: "Pick invoice F-0020" }));
    await user.click(screen.getByRole("button", { name: /Refund or credit \(1\)/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "Back to the card" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: "Credit next invoice" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows a Booqy fault on one invoice with Copy details, a Stripe refusal without", async () => {
    const user = userEvent.setup();
    mocks.billing.mockResolvedValue({ ...running(), invoices });
    mocks.creditNotes.mockResolvedValueOnce({ results: [
      { invoiceId: "in_a", ok: false, error: "internal_error", message: "The refund of this invoice did not finish" },
      { invoiceId: "in_d", ok: false, error: "stripe_error", message: "Stripe: card_declined" },
    ], ok: 0, failed: 2, refundedSek: 0, creditedSek: 0 });
    render(<BillingTab tenant={tenant} cardParam={null} onChanged={() => {}} />);
    await user.click(await screen.findByRole("checkbox", { name: "Pick invoice F-0010" }));
    await user.click(screen.getByRole("checkbox", { name: "Pick invoice F-0013" }));
    await user.click(screen.getByRole("button", { name: /Refund or credit \(2\)/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^Refund / }));
    const rows = await within(dialog).findAllByRole("listitem");
    const booqy = rows.find((r) => within(r).queryByText("F-0010"))!;
    const stripe = rows.find((r) => within(r).queryByText("F-0013"))!;
    expect(within(booqy).getByRole("button", { name: "Copy details" })).toBeInTheDocument();
    expect(within(stripe).getByText("Stripe: card_declined")).toBeInTheDocument();
    expect(within(stripe).queryByRole("button", { name: "Copy details" })).not.toBeInTheDocument();
  });
});
