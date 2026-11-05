import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExportLedgerSection from "./ExportLedgerSection";
import { exportLedger } from "./api";
import { api, ApiError } from "../../api";

vi.mock("./api", () => ({ exportLedger: vi.fn() }));
vi.mock("../../api", async (orig) => ({ ...(await orig<typeof import("../../api")>()), api: { tenant: vi.fn() } }));

const FILE = { locationId: "loc-1", from: "2026-01-01", to: "2026-11-05", format: "csv" as const, filename: "p.csv",
               count: 3, chainOk: true, content: "seq,kind\r\n" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.tenant).mockResolvedValue({ locations: [{ locationId: "loc-1", name: "Bistro Söder" }] } as never);
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});

describe("ExportLedgerSection", () => {
  it("exports the chosen location and reports an intact chain", async () => {
    vi.mocked(exportLedger).mockResolvedValue(FILE);
    render(<ExportLedgerSection tenantId="t1" />);
    expect(await screen.findByRole("option", { name: "Bistro Söder" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText(/the chain is intact/)).toBeInTheDocument();
    expect(vi.mocked(exportLedger).mock.calls[0][0]).toBe("t1");
    expect(vi.mocked(exportLedger).mock.calls[0][1].locationId).toBe("loc-1");
  });

  it("warns when the tamper check fails", async () => {
    vi.mocked(exportLedger).mockResolvedValue({ ...FILE, chainOk: false, firstBadSeq: 2 });
    render(<ExportLedgerSection tenantId="t1" />);
    await screen.findByRole("option", { name: "Bistro Söder" });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText(/Tamper check failed at record 2/)).toBeInTheDocument();
  });

  it("shows the error when nothing is there", async () => {
    vi.mocked(exportLedger).mockRejectedValue(new ApiError(404, "not_found", "No staff ledger records for this location."));
    render(<ExportLedgerSection tenantId="t1" />);
    await screen.findByRole("option", { name: "Bistro Söder" });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText(/No staff ledger records/)).toBeInTheDocument();
  });
});
