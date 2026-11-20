import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Tenant } from "../types";
import { SetupCard, SetupCell } from "./SetupCard";

const base = { tenantId: "t1", name: "Bistro", slug: "bistro", status: "active", planId: "growth",
  entitlements: { maxLocations: 2, features: {} }, locationCount: 2 } as unknown as Tenant;

describe("SetupCell", () => {
  it("shows progress, Finished, or a dash before the first check", () => {
    const { rerender } = render(<MemoryRouter><SetupCell tenantId="t1" setup={{ finished: 7, total: 9, complete: false }} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "7 of 9 Kom igång steps done or skipped" })).toHaveTextContent("7/9");
    rerender(<MemoryRouter><SetupCell tenantId="t1" setup={{ finished: 9, total: 9, complete: true, completedAt: "2026-11-18T10:00:00Z" }} /></MemoryRouter>);
    expect(screen.getByRole("link")).toHaveTextContent("Finished");
    rerender(<MemoryRouter><SetupCell tenantId="t1" setup={null} /></MemoryRouter>);
    expect(screen.getByText("-")).toBeInTheDocument();
  });
});

describe("SetupCard", () => {
  it("lists done, skipped and open steps, per location where they differ, and when it finished", () => {
    const tenant: Tenant = {
      ...base,
      setupCompletedAt: "2026-11-18T10:00:00.000Z",
      setupState: {
        complete: false, total: 3, done: 1, skipped: 1, open: 1,
        steps: [
          { id: "dpa", labelEn: "Accept the data processing agreement", scope: "tenant", state: "done" },
          { id: "stripe", labelEn: "Stripe for card payments", scope: "tenant", state: "skipped" },
          { id: "menu", labelEn: "Menu", scope: "location", state: "open",
            locations: [{ locationId: "l1", name: "Södermalm", state: "done" }, { locationId: "l2", name: "Vasastan", state: "open" }] },
        ],
      },
    };
    render(<MemoryRouter><SetupCard tenant={tenant} /></MemoryRouter>);
    const steps = within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem");
    expect(steps[0]).toHaveTextContent("Done");
    expect(steps[1]).toHaveTextContent("Skipped");
    expect(steps[2]).toHaveTextContent("Open");
    expect(steps[2]).toHaveTextContent("Södermalm: done, Vasastan: open");
    expect(screen.getByText(/18 Nov 2026/)).toBeInTheDocument();
  });

  it("says when it has not been checked yet", () => {
    render(<MemoryRouter><SetupCard tenant={base} /></MemoryRouter>);
    expect(screen.getByText(/Not checked yet/)).toBeInTheDocument();
  });
});
