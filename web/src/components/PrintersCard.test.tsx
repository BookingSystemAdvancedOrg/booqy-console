import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenantPrinters: vi.fn(), addPrinter: vi.fn(), updatePrinter: vi.fn(), testPrinter: vi.fn(), removePrinter: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import { PrintersCard, seenText } from "./PrintersCard";
import type { Location, Tenant } from "../types";

const tenant = { tenantId: "t1", name: "Roma" } as Tenant;
const locations = [
  { locationId: "l1", name: "Södermalm" }, { locationId: "l2", name: "Vasastan" }, { locationId: "l3", name: "Kungsholmen" },
] as Location[];
const recent = new Date(Date.now() - 30_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenantPrinters.mockResolvedValue({
    status: "offline",
    locations: [
      { locationId: "l1", status: "offline", setupSkipped: false, autoPrint: true, printers: [
        { deviceId: "a".repeat(32), name: "Köket", kind: "kok", protocol: "star", online: true, lastSeenAt: recent },
        { deviceId: "b".repeat(32), name: "Baren", kind: "dryck", protocol: "star", online: false },
      ] },
      { locationId: "l2", status: "skipped", setupSkipped: true, autoPrint: false, printers: [] },
      { locationId: "l3", status: "none", setupSkipped: false, autoPrint: false, printers: [] },
    ],
  });
});

describe("Printers card", () => {
  it("shows each location's printers: kind, connected and last seen, or why there are none", async () => {
    render(<PrintersCard tenant={tenant} locations={locations} />);
    const sod = await screen.findByRole("region", { name: "Printers at Södermalm" });
    expect(within(sod).getByText("1 offline")).toBeInTheDocument();
    const rows = within(sod).getAllByRole("row").slice(1);
    expect(rows.map((r) => [...r.querySelectorAll("td")].slice(0, 4).map((td) => td.textContent))).toEqual([
      ["Köket", "Kitchen", "Yes", "Just now"], ["Baren", "Drinks", "No", "Never"],
    ]);
    const vasa = screen.getByRole("region", { name: "Printers at Vasastan" });
    expect(within(vasa).getByText("Skipped")).toBeInTheDocument();
    expect(within(vasa).getByText(/Inga skrivare än/)).toBeInTheDocument();
    const kungs = screen.getByRole("region", { name: "Printers at Kungsholmen" });
    expect(within(kungs).getByText("No printers")).toBeInTheDocument();
  });

  it("adds a printer and shows the connection details once", async () => {
    mocks.addPrinter.mockResolvedValue({
      printer: { deviceId: "c".repeat(32), name: "Kök 2", kind: "kok", protocol: "star", online: false },
      username: "c".repeat(32), secret: "s3cret-value", serverUrl: `https://api.example/print/cloudprnt/${"c".repeat(32)}`,
    });
    render(<PrintersCard tenant={tenant} locations={locations} />);
    const kungs = await screen.findByRole("region", { name: "Printers at Kungsholmen" });
    await userEvent.click(within(kungs).getByRole("button", { name: "+ Add printer" }));
    const dialog = screen.getByRole("dialog", { name: "Add printer to Kungsholmen" });
    await userEvent.type(within(dialog).getByRole("textbox"), "Kök 2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add printer" }));
    expect(mocks.addPrinter).toHaveBeenCalledWith("t1", "l3", { name: "Kök 2", kind: "kok", protocol: "star" });
    const done = await screen.findByRole("dialog", { name: "Kök 2 added" });
    expect(within(done).getByText("Shown once. Read it to the restaurant now.")).toBeInTheDocument();
    expect(within(done).getByText("s3cret-value")).toBeInTheDocument();
    await userEvent.click(within(done).getByRole("button", { name: "Done" }));
    expect(screen.queryByText("s3cret-value")).toBeNull();
    expect(mocks.tenantPrinters).toHaveBeenCalledTimes(2);
  });

  it("test prints, renames and removes", async () => {
    mocks.testPrinter.mockResolvedValue({ status: "PENDING" });
    mocks.updatePrinter.mockResolvedValue({ printer: {} });
    mocks.removePrinter.mockResolvedValue({});
    render(<PrintersCard tenant={tenant} locations={locations} />);
    const sod = await screen.findByRole("region", { name: "Printers at Södermalm" });
    const [koket] = within(sod).getAllByRole("row").slice(1);
    await userEvent.click(within(koket).getByRole("button", { name: "Test print" }));
    expect(mocks.testPrinter).toHaveBeenCalledWith("t1", "l1", "a".repeat(32));
    expect(await within(koket).findByRole("button", { name: /Sent/ })).toBeInTheDocument();

    await userEvent.click(within(koket).getByRole("button", { name: "Edit" }));
    const edit = screen.getByRole("dialog", { name: "Edit Köket" });
    const name = within(edit).getByRole("textbox");
    await userEvent.clear(name);
    await userEvent.type(name, "Kök 1");
    await userEvent.click(within(edit).getByRole("button", { name: /Save/ }));
    expect(mocks.updatePrinter).toHaveBeenCalledWith("t1", "l1", "a".repeat(32), { name: "Kök 1" });

    await userEvent.click(within(koket).getByRole("button", { name: "Remove" }));
    const confirm = screen.getByRole("dialog", { name: "Remove Köket?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove printer" }));
    expect(mocks.removePrinter).toHaveBeenCalledWith("t1", "l1", "a".repeat(32));
  });
});

describe("seenText", () => {
  it("reads as minutes, hours, then a date", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    expect(seenText(undefined, now)).toBe("Never");
    expect(seenText("2026-11-17T11:59:30Z", now)).toBe("Just now");
    expect(seenText("2026-11-17T11:55:00Z", now)).toBe("5 min ago");
    expect(seenText("2026-11-17T09:00:00Z", now)).toBe("3 h ago");
    expect(seenText("2026-11-10T09:00:00Z", now)).toMatch(/10 Nov 2026/);
  });
});
