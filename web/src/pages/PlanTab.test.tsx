import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tenant, TenantDetail } from "../types";

const mocks = vi.hoisted(() => ({ plans: vi.fn(), setPlan: vi.fn(), tenant: vi.fn(), site: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import TenantPage, { PlanTab } from "./TenantPage";

const tenant: Tenant = {
  tenantId: "t1", name: "Pizzeria Roma", slug: "pizzeria-roma", status: "active", planId: "starter",
  entitlements: { maxLocations: 1, features: { reservations: true, ordering: true, marketing: false } }, locationCount: 1,
};
const STARTER = { planId: "starter", name: "Starter", maxLocations: 1, features: { reservations: true, ordering: true }, priceSek: 3950 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.plans.mockResolvedValue([STARTER]);
  mocks.setPlan.mockResolvedValue({ tenant });
});

const GROWTH = { planId: "growth", name: "Growth", maxLocations: 3, features: { reservations: true, ordering: true, catering: true, marketing: true }, priceSek: 8295 };
const FREE = { ...GROWTH, planId: "free", name: "Free", priceSek: 0, free: true };

describe("Plan tab: Free", () => {
  beforeEach(() => mocks.plans.mockResolvedValue([STARTER, GROWTH, FREE]));

  it("sets Free with the default end date and Starter afterwards", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
    try {
      render(<PlanTab tenant={tenant} onSaved={() => {}} />);
      await screen.findByText("Free");
      expect(screen.getByText("No charge, Growth's features")).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole("radio")[2]);
      expect(screen.getByLabelText(/^Free until/)).toHaveValue("2027-02-14");
      expect(screen.getByLabelText(/^Then switch to/)).toHaveValue("starter");
      expect(screen.queryByLabelText(/^Monthly price/)).not.toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
      expect(mocks.setPlan).toHaveBeenCalledWith("t1", expect.objectContaining({
        planId: "free", free: { until: "2027-02-14", thenPlanId: "starter" } }));
      expect(mocks.setPlan.mock.calls[0][1]).not.toHaveProperty("priceSek");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no end date, and the plan after it", async () => {
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    await screen.findByText("Free");
    fireEvent.click(screen.getAllByRole("radio")[2]);
    fireEvent.change(screen.getByLabelText(/^Then switch to/), { target: { value: "growth" } });
    fireEvent.click(screen.getByLabelText("No end date"));
    expect(screen.getByLabelText(/^Free until/)).toBeDisabled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan).toHaveBeenCalledWith("t1", expect.objectContaining({ planId: "free", free: { until: null, thenPlanId: "growth" } }));
  });

  it("extends a free period that is saved", async () => {
    const onFree = { ...tenant, planId: "free", billing: { freeUntil: "2027-02-14", freeThenPlanId: "growth" } };
    render(<PlanTab tenant={onFree} onSaved={() => {}} />);
    await screen.findByText("Free");
    expect(screen.getByLabelText(/^Free until/)).toHaveValue("2027-02-14");
    expect(screen.getByLabelText(/^Then switch to/)).toHaveValue("growth");
    expect(screen.getByRole("button", { name: "Save plan" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Free until/), { target: { value: "2027-05-14" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan).toHaveBeenCalledWith("t1", expect.objectContaining({ planId: "free", free: { until: "2027-05-14", thenPlanId: "growth" } }));
  });
});

describe("Plan tab", () => {
  it("lists every contract feature by its label, new ones unchecked", async () => {
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    await screen.findByText("Starter");
    expect(screen.getByLabelText("Reservations")).toBeChecked();
    expect(screen.getByLabelText("Marketing")).not.toBeChecked();
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
      overrides: { features: { marketing: false, siteBuilder: true }, limits: { siteBuilderAiEditsPerMonth: 25 } },
    });
  });

  it("lists the addendum features and the phone minutes limit, all off for an existing tenant", async () => {
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    await screen.findByText("Starter");
    expect(screen.getByLabelText("Events and tickets")).not.toBeChecked();
    expect(screen.getByLabelText("Phone agent")).not.toBeChecked();
    expect(screen.getByLabelText(/^Phone agent minutes per month/)).toHaveValue(0);
    expect(screen.getByLabelText(/^Phone agent minutes per month/)).toHaveAttribute("max", "100000");
    expect(screen.getByText("Used with Phone agent. The plan's is 0")).toBeInTheDocument();
  });

  it("sends a changed phone minutes limit as an override, keeping the tenant's other override", async () => {
    const own = { ...tenant, entitlements: { ...tenant.entitlements, limits: { siteBuilderAiEditsPerMonth: 25 } } };
    render(<PlanTab tenant={own} onSaved={() => {}} />);
    await screen.findByText("Starter");
    expect(screen.getByLabelText(/^AI site edits per month/)).toHaveValue(25);
    fireEvent.change(screen.getByLabelText(/^Phone agent minutes per month/), { target: { value: "300" } });
    fireEvent.click(screen.getByLabelText("Phone agent"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan).toHaveBeenCalledWith("t1", {
      planId: "starter", force: false, priceSek: 3950,
      overrides: { features: { marketing: false, phoneAgent: true },
                   limits: { siteBuilderAiEditsPerMonth: 25, phoneAgentMinutesPerMonth: 300 } },
    });
  });

  it("starts the phone minutes from another plan's value", async () => {
    mocks.plans.mockResolvedValue([STARTER, { planId: "growth", name: "Growth", maxLocations: 3, features: {},
                                              limits: { phoneAgentMinutesPerMonth: 300 } }]);
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText("Growth"));
    expect(await screen.findByLabelText(/^Phone agent minutes per month/)).toHaveValue(300);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan.mock.calls[0][1].overrides.limits).toBeUndefined();
  });

  it("neither shows nor sends a retired feature key the tenant and plan still carry", async () => {
    mocks.plans.mockResolvedValue([{ ...STARTER, features: { ...STARTER.features, terminal: true } }]);
    const legacy = { ...tenant, entitlements: { ...tenant.entitlements, features: { ...tenant.entitlements.features, terminal: true } } };
    render(<PlanTab tenant={legacy} onSaved={() => {}} />);
    await screen.findByText("Starter");
    expect(screen.queryByLabelText(/terminal/i)).toBeNull();
    expect(screen.queryByText(/terminal/i)).toBeNull();
    fireEvent.click(screen.getByLabelText("Site builder"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan.mock.calls[0][1].overrides.features).toEqual({ marketing: false, siteBuilder: true });
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

  it("shows with only the phone agent on", async () => {
    await renderTenant({ phoneAgent: true });
    fireEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect(screen.getByText(/Connections this customer has made/)).toBeInTheDocument();
  });

  it("stays hidden with only events and tickets on", async () => {
    await renderTenant({ events: true });
    expect(screen.queryByRole("button", { name: "Integrations" })).toBeNull();
  });

  it("leaves a retired feature key out of the Overview", async () => {
    await renderTenant({ reservations: true, terminal: true });
    expect(screen.getByText("Reservations")).toBeInTheDocument();
  });

  it("uses feature labels on the Overview", async () => {
    await renderTenant({ reservations: true, giftCards: true });
    expect(screen.getByText("Reservations, Gift cards")).toBeInTheDocument();
  });
});
