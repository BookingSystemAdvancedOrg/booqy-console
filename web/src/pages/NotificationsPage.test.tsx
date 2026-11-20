import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { NOTICES_SEEN_EVENT } from "../notices";
import type { OperatorNotice } from "../types";
import NotificationsPage from "./NotificationsPage";

const notice = (n: number, extra: Partial<OperatorNotice> = {}): OperatorNotice => ({
  id: `2026-11-1${n}T10:00:00.000Z#t${n}#setup_completed`, kind: "setup_completed", tenantId: `t${n}`,
  tenantName: `Bistro ${n}`, at: `2026-11-1${n}T10:00:00.000Z`, seenAt: null, ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("NotificationsPage", () => {
  it("lists Setup finished with time and a link to the customer, and marks new ones seen once", async () => {
    vi.spyOn(api, "notices").mockResolvedValue({ notices: [notice(8), notice(7, { seenAt: "2026-11-17T11:00:00.000Z" })], unseen: 1 });
    const seen = vi.spyOn(api, "markNoticesSeen").mockResolvedValue({ marked: 1, unseen: 0 });
    const cleared = vi.fn();
    window.addEventListener(NOTICES_SEEN_EVENT, cleared);
    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);
    const link = await screen.findByRole("link", { name: "Setup finished: Bistro 8" });
    expect(link).toHaveAttribute("href", "/tenants/t8");
    const rows = screen.getAllByRole("row");
    expect(await within(rows[1]).findByText("New")).toBeInTheDocument();
    expect(within(rows[2]).queryByText("New")).toBeNull();
    expect(within(rows[1]).getByText(/18 Nov 2026/)).toBeInTheDocument();
    await waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cleared).toHaveBeenCalled());
    window.removeEventListener(NOTICES_SEEN_EVENT, cleared);
  });

  it("does not mark anything when all are seen", async () => {
    vi.spyOn(api, "notices").mockResolvedValue({ notices: [notice(7, { seenAt: "x" })], unseen: 0 });
    const seen = vi.spyOn(api, "markNoticesSeen").mockResolvedValue({ marked: 0, unseen: 0 });
    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);
    await screen.findByRole("link", { name: "Setup finished: Bistro 7" });
    expect(seen).not.toHaveBeenCalled();
  });

  it("says so when there are none", async () => {
    vi.spyOn(api, "notices").mockResolvedValue({ notices: [], unseen: 0 });
    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);
    expect(await screen.findByText("No notifications.")).toBeInTheDocument();
  });
});
