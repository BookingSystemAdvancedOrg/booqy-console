import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), users: vi.fn(), plans: vi.fn(), billing: vi.fn(), stripeLink: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import TenantPage from "./TenantPage";
import type { TenantDetail } from "../types";

describe("Customer page when it fails to load", () => {
  it("keeps the way back to Customers, Refresh and Try again", async () => {
    mocks.tenant.mockRejectedValue(new TypeError("Failed to fetch"));
    render(
      <MemoryRouter initialEntries={["/tenants/t1"]}>
        <Routes><Route path="/tenants/:tenantId" element={<TenantPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Customer" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Customers" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeInTheDocument();
  });
});

const detail = {
  tenant: { tenantId: "t1", name: "Pizzeria Roma", slug: "roma", status: "active", planId: "starter", locationCount: 1,
            entitlements: { maxLocations: 1, features: {} } },
  domains: [], zones: [], locations: [], userCount: 1, onboarding: null, audit: [],
} as unknown as TenantDetail;
const renderPage = () => render(
  <MemoryRouter initialEntries={["/tenants/t1"]}>
    <Routes><Route path="/tenants/:tenantId" element={<TenantPage />} /></Routes>
  </MemoryRouter>,
);

describe("Customer page Users tab when the users fail to load (finding 180)", () => {
  it("shows Try again and no empty table; Try again and the page Refresh load them", async () => {
    mocks.tenant.mockReset().mockResolvedValue(detail);
    mocks.plans.mockReset().mockResolvedValue([]);
    mocks.users.mockReset().mockRejectedValue(new TypeError("Failed to fetch"));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Users" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "User" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.users).toHaveBeenCalledTimes(2);
    mocks.users.mockResolvedValue([{ cognitoSub: "u1", name: "Anna", email: "anna@roma.se", role: "owner_user", createdAt: "2026-10-01T10:00:00Z" }]);
    await userEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(await screen.findByText("Anna")).toBeInTheDocument();
    expect(mocks.users).toHaveBeenCalledTimes(3);
  });
});

describe("Customer page plan name (finding 211)", () => {
  it("shows the plan's display name, not its id", async () => {
    mocks.tenant.mockReset().mockResolvedValue(detail);
    mocks.plans.mockReset().mockResolvedValue([{ planId: "starter", name: "Starter Plus", maxLocations: 1, features: {} }]);
    renderPage();
    expect(await screen.findByText("Starter Plus - 1 of 1 locations")).toBeInTheDocument();
  });

  it("capitalises the id while the plans are not there", async () => {
    mocks.tenant.mockReset().mockResolvedValue(detail);
    mocks.plans.mockReset().mockRejectedValue(new TypeError("Failed to fetch"));
    renderPage();
    expect(await screen.findByText("Starter - 1 of 1 locations")).toBeInTheDocument();
  });
});

describe("Customer page Refresh and tabs that loaded fine (finding 180)", () => {
  it("does not load Users or Billing twice after an earlier Refresh", async () => {
    mocks.tenant.mockReset().mockResolvedValue(detail);
    mocks.plans.mockReset().mockResolvedValue([]);
    mocks.users.mockReset().mockResolvedValue([{ cognitoSub: "u1", name: "Anna", email: "anna@roma.se", role: "owner_user", createdAt: "2026-10-01T10:00:00Z" }]);
    mocks.billing.mockReset().mockReturnValue(new Promise(() => {}));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Refresh/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Users" }));
    expect(await screen.findByText("Anna")).toBeInTheDocument();
    expect(mocks.users).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Billing" }));
    expect(await screen.findByLabelText("Loading billing")).toBeInTheDocument();
    expect(mocks.billing).toHaveBeenCalledTimes(1);
  });
});

describe("Customer page Stripe onboarding link copy (finding 204)", () => {
  it("opens the link to copy by hand without clipboard access", async () => {
    const withStripe = { ...detail, tenant: { ...detail.tenant, stripe: { accountId: "acct_1" } } } as unknown as TenantDetail;
    mocks.tenant.mockReset().mockResolvedValue(withStripe);
    mocks.plans.mockReset().mockResolvedValue([]);
    mocks.stripeLink.mockReset().mockResolvedValue({ url: "https://connect.stripe.com/setup/abc" });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Payments" }));
    await userEvent.click(screen.getByRole("button", { name: "Create onboarding link" }));
    await userEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(await screen.findByLabelText("Copy by hand")).toHaveValue("https://connect.stripe.com/setup/abc");
  });
});
