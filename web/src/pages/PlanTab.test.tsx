import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant, TenantDetail } from "../types";

const mocks = vi.hoisted(() => ({ plans: vi.fn(), setPlan: vi.fn(), tenant: vi.fn(), site: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import TenantPage, { PlanTab } from "./TenantPage";

const tenant: Tenant = {
  tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", status: "active", planId: "starter",
  entitlements: { maxLocations: 1, features: { reservations: true, ordering: true, kassa: false } }, locationCount: 1,
};
const STARTER = { planId: "starter", name: "Starter", maxLocations: 1, features: { reservations: true, ordering: true }, priceSek: 3950 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.plans.mockResolvedValue([STARTER]);
  mocks.setPlan.mockResolvedValue({ tenant });
});

describe("Plan tab", () => {
  it("lists every contract feature by its label, new ones unchecked", async () => {
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    await screen.findByText("Starter");
    expect(screen.getByLabelText("Reservations")).toBeChecked();
    expect(screen.getByLabelText("Kassa (cash register)")).not.toBeChecked();
    for (const label of ["Meta ads", "Site builder", "Guest CRM", "Google Business Profile", "Gift cards", "Waitlist",
      "Social posting", "Staff ledger (personalliggare)", "Fortnox/Visma posting", "Margin per dish"]) {
      expect(screen.getByLabelText(label)).not.toBeChecked();
    }
    expect(screen.getByLabelText(/^AI site edits per month/)).toHaveValue(0);
  });

  it("sends a changed AI edit limit and a new feature as overrides, nothing else", async () => {
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    await screen.findByText("Starter");
    fireEvent.change(screen.getByLabelText(/^AI site edits per month/), { target: { value: "25" } });
    fireEvent.click(screen.getByLabelText("Site builder"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan).toHaveBeenCalledWith("t1", {
      planId: "starter", force: false, priceSek: 3950,
      overrides: { features: { kassa: false, siteBuilder: true }, limits: { siteBuilderAiEditsPerMonth: 25 } },
    });
  });

  it("sends no limit when it equals the plan's", async () => {
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    await screen.findByText("Starter");
    fireEvent.change(screen.getByLabelText(/^Monthly price, SEK ex VAT/), { target: { value: "4000" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan.mock.calls[0][1].overrides.limits).toBeUndefined();
  });
});

function detail(features: Record<string, boolean>): TenantDetail {
  return { tenant: { ...tenant, entitlements: { ...tenant.entitlements, features } }, domains: [], zones: [], locations: [],
           userCount: 1, onboarding: null, audit: [] };
}

async function renderTenant(features: Record<string, boolean>) {
  mocks.tenant.mockResolvedValue(detail(features));
  render(
    <MemoryRouter initialEntries={["/tenants/t1"]}>
      <Routes><Route path="/tenants/:tenantId" element={<TenantPage />} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: /Pizzeria Roma/ });
}

describe("Integrations tab", () => {
  it("is hidden while Meta ads and Google Business Profile are off", async () => {
    await renderTenant({ reservations: true });
    expect(screen.queryByRole("button", { name: "Integrations" })).toBeNull();
    expect(screen.getByRole("button", { name: "Website" })).toBeInTheDocument();
  });

  it("shows after Website when either feature is on", async () => {
    await renderTenant({ googleBusiness: true });
    const tabs = screen.getAllByRole("button").map((b) => b.textContent);
    expect(tabs.indexOf("Integrations")).toBe(tabs.indexOf("Website") + 1);
    fireEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect(screen.getByText(/Connections this customer has made/)).toBeInTheDocument();
  });

  it("uses feature labels on the Overview", async () => {
    await renderTenant({ reservations: true, giftCards: true });
    expect(screen.getByText("Reservations, Gift cards")).toBeInTheDocument();
  });
});
