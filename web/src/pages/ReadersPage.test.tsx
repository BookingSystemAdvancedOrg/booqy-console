import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderFleet } from "../types";

const mocks = vi.hoisted(() => ({ allReaders: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import ReadersPage from "./ReadersPage";

const fleet: ReaderFleet = {
  readers: [
    { id: "tmr_1", label: "Kassan", device_type: "stripe_s700", status: "online", serial_number: "S7-1",
      accountId: "acct_a", tenantId: "t1", tenantName: "Pizzeria Roma", locationId: "l1", locationName: "Roma Södermalm" },
    { id: "tmr_2", label: "Baren", device_type: "stripe_s710", status: "offline",
      accountId: "acct_b", tenantId: "t2", tenantName: "Bistro Linnea", locationId: "l2", locationName: "Linnea City" },
    { id: "tmr_old", label: "Gammal", device_type: "bbpos_wisepos_e", status: "offline",
      accountId: "acct_a", tenantId: "t1", tenantName: "Pizzeria Roma", locationId: null },
  ],
  locations: [
    { tenantId: "t1", tenantName: "Pizzeria Roma", locationId: "l1", locationName: "Roma Södermalm", terminalLocationId: "tml_1", accountId: "acct_a", readerCount: 1 },
    { tenantId: "t3", tenantName: "Café Nord", locationId: "l3", locationName: "Nord Torget", terminalLocationId: "tml_3", accountId: "acct_c", readerCount: 0 },
  ],
  errors: [{ accountId: "acct_x", tenantId: "t9", tenantName: "Krogen", message: "Stripe didn't answer" }],
};

function renderPage() {
  return render(<MemoryRouter><ReadersPage /></MemoryRouter>);
}

beforeEach(() => mocks.allReaders.mockReset().mockResolvedValue(fleet));

describe("ReadersPage", () => {
  it("lists every reader with its customer and location", async () => {
    renderPage();
    expect(await screen.findByText("Kassan")).toBeInTheDocument();
    expect(screen.getByText("Roma Södermalm")).toBeInTheDocument();
    expect(screen.getByText("Linnea City")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Pizzeria Roma" })[0]).toHaveAttribute("href", "/tenants/t1");
    expect(screen.getByText(/Not at a Booqy location: remove it/)).toBeInTheDocument();
    expect(screen.getByText("Nord Torget")).toBeInTheDocument();          // terminals on, no reader yet
    expect(screen.getByText(/Couldn't read the readers of/)).toBeInTheDocument();
  });

  it("filters by status and searches by customer", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Kassan");
    await user.click(screen.getByRole("button", { name: /^Offline/ }));
    expect(screen.queryByText("Kassan")).not.toBeInTheDocument();
    expect(screen.getByText("Baren")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Search reader/), "linnea");
    expect(screen.queryByText("Gammal")).not.toBeInTheDocument();
    expect(screen.getByText("Baren")).toBeInTheDocument();
  });
});
