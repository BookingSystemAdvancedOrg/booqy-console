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
});
