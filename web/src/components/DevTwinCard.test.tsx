import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ devTwin: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import { DevTwinCard, devTwinBusy } from "./DevTwinCard";
import type { Tenant } from "../types";

const base = { tenantId: "t1", name: "Anar", slug: "anar" } as Tenant;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.devTwin.mockResolvedValue({ devTwin: { status: "queued", steps: {} } });
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
      status: "partial", ownerEmail: "dev+anar@booqy.se", finishedAt: "2026-11-18T10:00:00Z",
      steps: { owner: { ok: true }, menu: { ok: true, note: "Added 13 dishes" }, layout: { ok: false, note: "publish-layout: 409 invalid_layout" } },
    } } as Tenant;
    render(<DevTwinCard tenant={tenant} onChanged={() => {}} />);
    expect(screen.getByText("Partly set up")).toBeInTheDocument();
    expect(screen.getByText("dev+anar@booqy.se")).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Kom igång steps" });
    expect([...steps.querySelectorAll("li")].map((li) => li.className)).toEqual(["is-ok", "is-ok", "is-failed"]);
    expect(screen.getByText("publish-layout: 409 invalid_layout")).toBeInTheDocument();
    expect(screen.queryByText("Added 13 dishes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh dev twin/ })).toBeEnabled();
  });

  it("is busy while the seed runs", () => {
    const tenant = { ...base, devTwin: { status: "running", steps: {} } } as Tenant;
    expect(devTwinBusy(tenant)).toBe(true);
    expect(devTwinBusy({ ...base, devTwin: { status: "ready", steps: {} } } as Tenant)).toBe(false);
    render(<DevTwinCard tenant={tenant} onChanged={() => {}} />);
    expect(screen.getByRole("button", { name: /Setting up/ })).toBeDisabled();
  });
});
