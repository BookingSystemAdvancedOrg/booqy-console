import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Zone } from "../types";

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(), checkZone: vi.fn(), retryZone: vi.fn(), notifyZone: vi.fn(), removeZone: vi.fn(),
  zoneAuthCode: vi.fn(), simulateZone: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import { Domains } from "./TenantPage";
import type { TenantDetail } from "../types";

const base = { hasDocument: false } as const;

function detail(zones: Partial<Zone>[], siteKind?: string) {
  return {
    tenant: { tenantId: "t1", slug: "roma", name: "Roma", status: "active", planId: "growth", siteKind },
    domains: [], zones: zones.map((z) => ({ ...base, ...z })), locations: [], userCount: 1, onboarding: null, audit: [],
  };
}

async function openDomains() {
  const data = (await mocks.tenant()) as TenantDetail;
  render(<MemoryRouter><Domains detail={data} onChanged={() => {}} /></MemoryRouter>);
}

beforeEach(() => { for (const m of Object.values(mocks)) m.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

describe("Own domains on the Domains tab", () => {
  it("records mode: what to add, the restaurant's Swedish steps, Check now and E-mail steps", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    mocks.tenant.mockResolvedValue(detail([{
      domain: "roma.se", mode: "records", status: "awaiting_records", canonicalHost: "www.roma.se", statusDetail: "No www record yet",
      records: [{ type: "CNAME", name: "www", host: "www.roma.se", value: "d111.cloudfront.net", purpose: "site" }],
      restaurantSteps: "Er hemsida ska snart synas på www.roma.se.", canRemove: true,
    }]));
    mocks.checkZone.mockResolvedValue({ result: "pending" });
    await openDomains();
    const card = screen.getByRole("region", { name: "roma.se" });
    expect(within(card).getByText(/^DNS records ·/)).toBeInTheDocument();
    expect(within(card).getByText("d111.cloudfront.net")).toBeInTheDocument();
    expect(within(card).getByText(/Er hemsida ska snart synas/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Check now" }));
    expect(mocks.checkZone).toHaveBeenCalledWith("t1", "roma.se");
    expect(within(card).getByRole("button", { name: "E-mail steps" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Simulate/ })).toBeNull();
  });

  it("a declined move says who acts and offers Move again, not Retry", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    mocks.tenant.mockResolvedValue(detail([{
      domain: "roma.com", mode: "transfer_in", status: "transfer_rejected", who: "restaurant", errorCode: "bad_auth_code",
      lastError: "The transfer code is wrong or expired.", lastErrorSv: "Flyttkoden stämmer inte.",
      restaurantSteps: "Flyttkoden stämmer inte.", canResubmit: true, canRetry: false, canRemove: true,
    }]));
    await openDomains();
    const card = screen.getByRole("region", { name: "roma.com" });
    expect(within(card).getByText(/The restaurant acts/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Move again" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("live: the site, its 301s and dev; Retry dev when only dev failed; the transfer code for a bought domain", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "prod");
    mocks.tenant.mockResolvedValue(detail([{
      domain: "roma.se", mode: "register", status: "live", canonicalHost: "roma.se", aliasHosts: ["www.roma.se"],
      devHost: "dev.roma.se", devStatus: "failed", devError: "validation_timeout", canRetry: true, registered: true,
      registrar: "route53", canRemove: true,
    }]));
    mocks.zoneAuthCode.mockResolvedValue({ authCode: "Xy-123" });
    await openDomains();
    const card = screen.getByRole("region", { name: "roma.se" });
    expect(within(card).getByText("www.roma.se + slug address")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Retry dev" })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Show transfer code" }));
    expect(await within(card).findByText("Xy-123")).toBeInTheDocument();
    expect(mocks.zoneAuthCode).toHaveBeenCalledWith("t1", "roma.se", false);
  });

  it("dev console: a simulated order gets the Simulate control for its state", async () => {
    vi.stubEnv("VITE_ENVIRONMENT", "dev");
    mocks.tenant.mockResolvedValue(detail([{
      domain: "roma.com", mode: "transfer_in", status: "awaiting_owner_approval", simulated: true, canRemove: false,
    }], "test"));
    mocks.simulateZone.mockResolvedValue({ result: "done" });
    await openDomains();
    const card = screen.getByRole("region", { name: "roma.com" });
    expect(within(card).getByText("simulated")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("combobox", { name: "Simulate" }));
    await userEvent.click(await screen.findByRole("option", { name: "Approve" }));
    await userEvent.click(within(card).getByRole("button", { name: "Simulate" }));
    expect(mocks.simulateZone).toHaveBeenCalledWith("t1", "roma.com", "approve");
  });
});
