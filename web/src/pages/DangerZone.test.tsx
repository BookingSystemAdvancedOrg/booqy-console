import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant } from "../types";

const mocks = vi.hoisted(() => ({ restore: vi.fn(), purgeNow: vi.fn(), offboard: vi.fn(), suspend: vi.fn(), resume: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import { Danger } from "./TenantPage";

const base: Tenant = {
  tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", status: "active", planId: "starter",
  entitlements: { maxLocations: 1, features: {} }, locationCount: 1, ownerEmail: "owner@roma.se",
};
const later = new Date(Date.now() + 30 * 86400000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("Danger zone", () => {
  it("offers Suspend and Offboard to an active customer, not Restore or Delete", () => {
    render(<Danger tenant={base} onChanged={() => {}} />);
    expect(screen.getByRole("button", { name: "Suspend customer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Offboard customer" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Restore customer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete customer" })).toBeNull();
  });

  it("restores an offboarded customer before the deadline", async () => {
    const onChanged = vi.fn();
    mocks.restore.mockResolvedValue({ usersEnabled: 2, failed: [] });
    render(<Danger tenant={{ ...base, status: "offboarded", purgeAt: later }} onChanged={onChanged} />);
    expect(screen.getByText(/Restorable until/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore customer" }));
    expect(mocks.restore).toHaveBeenCalledWith("t1");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("deletes an offboarded customer after the slug is typed and shows a repo refusal", async () => {
    mocks.purgeNow.mockResolvedValue({ purgeAt: new Date().toISOString(), repoError: "GitHub refused (403)" });
    render(<Danger tenant={{ ...base, status: "offboarded", purgeAt: later }} onChanged={() => {}} />);
    const button = screen.getByRole("button", { name: "Delete customer" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type the slug/), "pizzeria-roma");
    await userEvent.click(button);
    expect(mocks.purgeNow).toHaveBeenCalledWith("t1", "pizzeria-roma");
    expect(await screen.findByText(/website repo was not deleted: GitHub refused/)).toBeInTheDocument();
  });

  it("offers no Restore once the deadline has passed", () => {
    render(<Danger tenant={{ ...base, status: "offboarded", purgeAt: "2020-01-01T00:00:00Z" }} onChanged={() => {}} />);
    expect(screen.queryByRole("button", { name: "Restore customer" })).toBeNull();
    expect(screen.getByText(/deleted at the next deletion run/)).toBeInTheDocument();
  });

  it("tells that a purged customer's slug is free again", () => {
    render(<Danger tenant={{ ...base, status: "purged", purgedAt: "2026-10-01T00:00:00Z" }} onChanged={() => {}} />);
    expect(screen.getByText(/The slug is free again/)).toBeInTheDocument();
  });
});
