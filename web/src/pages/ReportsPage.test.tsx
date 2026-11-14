import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { SupportReport } from "../types";
import ReportsPage, { browserOf } from "./ReportsPage";

const report = (n: number, extra: Partial<SupportReport> = {}): SupportReport => ({
  reportId: `20261114T10000${n}000Z-0000000${n}`, tenantId: `t${n}`, tenantName: `Restaurant ${n}`, userSub: "sub", role: "owner_user",
  code: "internal_error", status: 500, path: `/p${n}`, requestId: `req-${n}`, appVersion: "Ab12", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Chrome/131",
  createdAt: `2026-11-14T10:00:0${n}.000Z`, handled: false, handledAt: null, handledBy: null, ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("ReportsPage", () => {
  it("lists newest first as the API returns them, open by default, and marks one handled", async () => {
    const list = vi.spyOn(api, "supportReports").mockResolvedValue({ items: [report(2), report(1)], cursor: null });
    const mark = vi.spyOn(api, "markReport").mockImplementation(async (id, handled) => ({ ...report(2), reportId: id, handled, handledBy: "ops" }));
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    const rows = await screen.findAllByRole("row");
    expect(list).toHaveBeenCalledWith("open");
    expect(within(rows[1]).getByText("Restaurant 2")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Restaurant 1")).toBeInTheDocument();
    expect(within(rows[1]).getByText("req-2")).toBeInTheDocument();
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Mark handled" }));
    await waitFor(() => expect(mark).toHaveBeenCalledWith(report(2).reportId, true));
    expect(await within(rows[1]).findByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });

  it("switches between open, handled and all", async () => {
    const list = vi.spyOn(api, "supportReports").mockResolvedValue({ items: [], cursor: null });
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    expect(await screen.findByText("No open reports.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith("all"));
  });

  it("loads older reports with the cursor", async () => {
    const list = vi.spyOn(api, "supportReports")
      .mockResolvedValueOnce({ items: [report(2)], cursor: "c1" })
      .mockResolvedValueOnce({ items: [report(1)], cursor: null });
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Restaurant 1")).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith("open", "c1");
  });

  it("names the browser", () => {
    expect(browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1")).toBe("Safari on iOS");
    expect(browserOf(null)).toBe("-");
  });
});
