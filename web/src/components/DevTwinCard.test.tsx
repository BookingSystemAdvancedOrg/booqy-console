import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ devTwin: vi.fn(), devTwinContent: vi.fn(), devTwinRefreshAll: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import { DevKindBadge, DevTwinCard, devKind, devTwinBusy } from "./DevTwinCard";
import type { Tenant } from "../types";

const base = { tenantId: "t1", name: "Anar", slug: "anar" } as Tenant;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.devTwin.mockResolvedValue({ devTwin: { status: "queued", steps: {} } });
  mocks.devTwinContent.mockResolvedValue({ devTwinContent: { status: "queued", steps: {} } });
});

describe("Dev twin card", () => {
  it("offers to create a twin that doesn't exist yet", async () => {
    const changed = vi.fn();
    render(<DevTwinCard tenant={base} onChanged={changed} />);
    expect(screen.getByText("Not set up yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Create dev twin/ }));
    expect(mocks.devTwin).toHaveBeenCalledWith("t1");
    expect(changed).toHaveBeenCalled();
  });

  it("shows the owner login and each step, with why a step failed", () => {
    const tenant = { ...base, devTwin: {
      status: "partial", ownerEmail: "aws+anar@ithjalparna.se", finishedAt: "2026-11-18T10:00:00Z",
      steps: { owner: { ok: true }, menu: { ok: true, note: "Added 13 dishes" }, layout: { ok: false, note: "publish-layout: 409 invalid_layout" } },
    } } as Tenant;
    render(<DevTwinCard tenant={tenant} onChanged={() => {}} />);
    expect(screen.getByText("Partly done")).toBeInTheDocument();
    expect(screen.getByText("aws+anar@ithjalparna.se")).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Kom igång steps" });
    expect([...steps.querySelectorAll("li")].map((li) => li.className)).toEqual(["is-ok", "is-ok", "is-failed"]);
    expect(screen.getByText("publish-layout: 409 invalid_layout")).toBeInTheDocument();
    expect(screen.queryByText("Added 13 dishes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh dev twin/ })).toBeEnabled();
  });

  it("shows the guest feature steps in seed order", () => {
    const tenant = { ...base, devTwin: {
      status: "ready", steps: { legal: { ok: true }, catering: { ok: true }, features: { ok: true },
        events: { ok: true }, giftCards: { ok: true }, waitlist: { ok: true } },
    } } as Tenant;
    render(<DevTwinCard tenant={tenant} onChanged={() => {}} />);
    const steps = screen.getByRole("list", { name: "Kom igång steps" });
    expect([...steps.querySelectorAll("li")].map((li) => li.textContent)).toEqual(
      ["✓All guest features", "✓Catering", "✓Gift cards", "✓Waitlist", "✓Test event", "✓Seller details"]);
  });

  it("refreshes every dev twin and lists what started and what was left alone", async () => {
    mocks.devTwinRefreshAll.mockResolvedValue({ queued: ["anar", "it-hjalparna-nordic-ab"],
      skipped: [{ slug: "roma", reason: "Already running" }] });
    const changed = vi.fn();
    render(<DevTwinCard tenant={{ ...base, devTwin: { status: "ready", steps: {} } } as Tenant} onChanged={changed} />);
    await userEvent.click(screen.getByRole("button", { name: /Refresh all dev twins/ }));
    expect(mocks.devTwinRefreshAll).toHaveBeenCalledWith("t1");
    expect(changed).toHaveBeenCalled();
    const list = screen.getByRole("list", { name: "Refresh all" });
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual(
      ["✓anar", "✓it-hjalparna-nordic-ab", "-romaAlready running"]);
    expect(mocks.devTwin).not.toHaveBeenCalled();
  });

  it("is busy while the seed runs", () => {
    const tenant = { ...base, devTwin: { status: "running", steps: {} } } as Tenant;
    expect(devTwinBusy(tenant)).toBe(true);
    expect(devTwinBusy({ ...base, devTwin: { status: "ready", steps: {} } } as Tenant)).toBe(false);
    render(<DevTwinCard tenant={tenant} onChanged={() => {}} />);
    expect(screen.getByRole("button", { name: /Setting up/ })).toBeDisabled();
  });

  it("copies the real restaurant's public content on demand and shows the last copy", async () => {
    const changed = vi.fn();
    const tenant = { ...base, devTwinContent: {
      status: "ready", copiedAt: "2026-11-18T12:00:00Z",
      steps: { source: { ok: true }, menu: { ok: true }, layout: { ok: false, note: "Prod has no active table layout yet" } },
    } } as Tenant;
    render(<DevTwinCard tenant={tenant} onChanged={changed} />);
    const copy = screen.getByRole("list", { name: "Copy steps" });
    expect([...copy.querySelectorAll("li")].map((li) => li.textContent)).toEqual(
      ["✓Prod restaurant", "✓Menu and photos", "!Table layoutProd has no active table layout yet"]);
    await userEvent.click(screen.getByRole("button", { name: /Copy public content now/ }));
    expect(mocks.devTwinContent).toHaveBeenCalledWith("t1");
    expect(changed).toHaveBeenCalled();
  });

  it("flags a twin whose prod customer was offboarded, and never deletes it", () => {
    render(<DevTwinCard tenant={{ ...base, twinProdOffboardedAt: "2026-11-18T12:00:00Z" } as Tenant} onChanged={() => {}} />);
    expect(screen.getByText(/This twin stays until you offboard it/)).toBeInTheDocument();
  });

  it("tells twins from dev test customers", () => {
    expect(devKind({ slug: "roma", siteKind: "test" })).toBe("test");
    expect(devKind({ slug: "roma", siteKind: "prod-link" })).toBe("twin");
    expect(devKind({ slug: "roma", twinOf: { env: "prod", tenantId: "p1" } })).toBe("twin");
    expect(devKind({ slug: "anar" })).toBe("twin");
    expect(devKind({ slug: "roma" })).toBe(null);
    const { rerender } = render(<DevKindBadge kind="twin" />);
    expect(screen.getByText("Twin of prod")).toBeInTheDocument();
    rerender(<DevKindBadge kind="test" />);
    expect(screen.getByText("Dev test")).toBeInTheDocument();
  });
});
