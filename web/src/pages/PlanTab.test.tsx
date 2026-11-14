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

  it("three options; a timed one needs the plan and price after it, then sends the preset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
    try {
      render(<PlanTab tenant={tenant} onSaved={() => {}} />);
      await screen.findByText("Free");
      expect(screen.getByText("No charge")).toBeInTheDocument();
      expect(screen.getByText("Multiple locations")).toBeInTheDocument();
      expect(screen.getByText("1 location")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Free"));
      expect(screen.getByRole("radio", { name: /Free for 3 months/ })).toBeChecked();
      expect(screen.getByRole("radio", { name: /Free until changed/ })).not.toBeChecked();
      expect(screen.getByRole("radio", { name: /Free for 6 months/ })).not.toBeChecked();
      expect(screen.getByTestId("free-fields").querySelector("input[type=date]")).toBeNull();   // no date picker
      expect(screen.getByText("Free until 13 Feb 2027")).toBeInTheDocument();
      expect(screen.getByLabelText(/^Then switch to/)).toHaveValue("");
      expect(screen.getByLabelText(/^Locations/)).toHaveValue(1);                 // Free starts at 1
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
      expect(mocks.setPlan).not.toHaveBeenCalled();
      expect(screen.getByText("Pick the plan after Free")).toBeInTheDocument();
      expect(screen.getByText("Set the monthly price after Free")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(/^Then switch to/), { target: { value: "starter" } });
      expect(screen.getByLabelText(/^Monthly price after Free/)).toHaveValue(3950);  // filled in from the plan
      fireEvent.click(screen.getByRole("radio", { name: /Free for 6 months/ }));
      expect(screen.getByText("Free until 13 May 2027")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(/^Monthly price after Free/), { target: { value: "" } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
      expect(mocks.setPlan).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText(/^Monthly price after Free/), { target: { value: "450" } });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
      expect(mocks.setPlan).toHaveBeenCalledWith("t1", expect.objectContaining({
        planId: "free", free: { preset: "6m", thenPlanId: "starter" }, priceSek: 450, overrides: expect.objectContaining({ maxLocations: 1 }) }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("free until changed: no end, no plan or price needed", async () => {
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    await screen.findByText("Free");
    fireEvent.click(screen.getByText("Free"));
    fireEvent.click(screen.getByRole("radio", { name: /Free until changed/ }));
    expect(screen.queryByLabelText(/^Then switch to/)).toBeNull();
    expect(screen.queryByLabelText(/^Monthly price after Free/)).toBeNull();
    expect(screen.queryByTestId("free-until")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan).toHaveBeenCalledWith("t1", expect.objectContaining({ planId: "free", free: { preset: "until_changed" } }));
  });

  it("an older Free customer with an own end date loads and saves it unchanged", async () => {
    const onFree = { ...tenant, planId: "free", entitlements: { ...tenant.entitlements, maxLocations: 3 },
                     billing: { freeUntil: "2027-02-20", freeSince: "2026-11-14", freeThenPlanId: "growth" } };
    render(<PlanTab tenant={onFree} onSaved={() => {}} />);
    await screen.findByText("Free");
    for (const name of [/Free until changed/, /Free for 3 months/, /Free for 6 months/]) expect(screen.getByRole("radio", { name })).not.toBeChecked();
    expect(screen.getByText("Free until 20 Feb 2027")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Then switch to/)).toHaveValue("growth");
    expect(screen.getByLabelText(/^Monthly price after Free/)).toHaveValue(8295);
    expect(screen.getByLabelText(/^Locations/)).toHaveValue(3);
    expect(screen.getByRole("button", { name: "Save plan" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "More locations" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan).toHaveBeenCalledWith("t1", expect.objectContaining({
      planId: "free", free: { until: "2027-02-20", thenPlanId: "growth" }, overrides: expect.objectContaining({ maxLocations: 4 }) }));
  });

  it("an older Free customer without an end loads as Free until changed", async () => {
    const onFree = { ...tenant, planId: "free", billing: { freeThenPlanId: "starter" } };
    render(<PlanTab tenant={onFree} onSaved={() => {}} />);
    await screen.findByText("Free");
    expect(screen.getByRole("radio", { name: /Free until changed/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save plan" })).toBeDisabled();
  });

  it("keeps an own price as the price after Free", async () => {
    const own = { ...tenant, billing: { ...(tenant.billing ?? {}), priceSek: 500 } };
    render(<PlanTab tenant={own} onSaved={() => {}} />);
    await screen.findByText("Free");
    fireEvent.click(screen.getByText("Free"));
    expect(screen.getByLabelText(/^Monthly price after Free/)).toHaveValue(500);
    fireEvent.change(screen.getByLabelText(/^Then switch to/), { target: { value: "growth" } });
    expect(screen.getByLabelText(/^Monthly price after Free/)).toHaveValue(500);        // an own price stays
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan).toHaveBeenCalledWith("t1", expect.objectContaining({ planId: "free", priceSek: 500 }));
  });
});

describe("Plan tab: locations and features", () => {
  it("the stepper starts at the plan's number, stays within 1 to 100 and is saved", async () => {
    mocks.plans.mockResolvedValue([STARTER, GROWTH]);
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    await screen.findByText("Starter");
    expect(screen.queryByLabelText(/Locations allowed/)).toBeNull();
    expect(screen.getByLabelText(/^Locations/)).toHaveValue(1);
    expect(screen.getByRole("button", { name: "Fewer locations" })).toBeDisabled();
    fireEvent.click(screen.getByText("Growth"));
    expect(screen.getByLabelText(/^Locations/)).toHaveValue(3);
    fireEvent.click(screen.getByRole("button", { name: "Fewer locations" }));
    fireEvent.click(screen.getByRole("button", { name: "Fewer locations" }));
    fireEvent.click(screen.getByRole("button", { name: "Fewer locations" }));
    expect(screen.getByLabelText(/^Locations/)).toHaveValue(1);
    fireEvent.change(screen.getByLabelText(/^Locations/), { target: { value: "500" } });
    expect(screen.getByLabelText(/^Locations/)).toHaveValue(100);
    expect(screen.getByRole("button", { name: "More locations" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Locations/), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save plan" })); });
    expect(mocks.setPlan.mock.calls[0][1]).toMatchObject({ planId: "growth", overrides: { maxLocations: 5 } });
  });

  it("Select all ticks every feature, Clear all unticks them", async () => {
    render(<PlanTab tenant={tenant} onSaved={() => {}} />);
    await screen.findByText("Starter");
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByLabelText("Marketing")).toBeChecked();
    expect(screen.getByLabelText("Phone agent")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByLabelText("Reservations")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Select all" })).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
  });

  it("shows with only the phone agent on", async () => {
    await renderTenant({ phoneAgent: true });
    fireEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
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
