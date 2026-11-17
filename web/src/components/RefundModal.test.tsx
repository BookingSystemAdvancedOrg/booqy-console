import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Invoice } from "../types";

const mocks = vi.hoisted(() => ({ creditNotes: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ api: mocks, ApiError: (await importOriginal<typeof import("../api")>()).ApiError }));

import { RefundModal } from "./RefundModal";

const invoice = {
  invoiceId: "in_1", number: "B-1", status: "paid", subtotalSek: 400, taxSek: 100, totalSek: 500,
  amountPaidSek: 500, amountRemainingSek: 0, outstandingSek: 0, paidOutOfBand: false, daysLate: 0,
  remindersSent: 0, creditableSek: 500, refundable: true,
} as unknown as Invoice;

describe("RefundModal", () => {
  it("cannot be cancelled while a refund is in flight", async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void = () => {};
    mocks.creditNotes.mockReturnValue(new Promise((r) => { resolve = r; }));
    const onClose = vi.fn();
    const onDone = vi.fn();
    render(<RefundModal tenantId="t-1" invoices={[invoice]} onClose={onClose} onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: /^Refund 500/ }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toBeDisabled());
    await user.click(cancel);
    expect(onClose).not.toHaveBeenCalled();
    resolve({ results: [{ invoiceId: "in_1", ok: true }], ok: 1, failed: 0 });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("words the credit by the invoice's state: an open invoice lowers what is owed", () => {
    const open = { ...invoice, invoiceId: "in_2", number: "B-2", status: "open", amountPaidSek: 0, amountRemainingSek: 500, refundable: false } as Invoice;
    const { unmount } = render(<RefundModal tenantId="t-1" invoices={[open]} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByRole("radio", { name: "Lower what is owed" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("radio", { name: "Credit next invoice" })).toBeNull();
    unmount();
    const paid = render(<RefundModal tenantId="t-1" invoices={[invoice]} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByRole("radio", { name: "Credit next invoice" })).toBeInTheDocument();
    paid.unmount();
    render(<RefundModal tenantId="t-1" invoices={[invoice, open]} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByRole("radio", { name: "Lower owed or next invoice" })).toBeInTheDocument();
  });
});
