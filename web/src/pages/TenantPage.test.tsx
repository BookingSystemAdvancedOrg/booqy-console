import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), users: vi.fn(), plans: vi.fn(), billing: vi.fn(), stripeLink: vi.fn(),
  updateUser: vi.fn(), deleteUser: vi.fn(), resendUserInvite: vi.fn(), createUser: vi.fn(), disableUser: vi.fn(), enableUser: vi.fn() }));
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
    expect(screen.getByRole("link", { name: "Customers" })).toHaveAttribute("href", "/");
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
    mocks.users.mockResolvedValue({ users: [{ cognitoSub: "u1", name: "Anna", email: "anna@roma.se", role: "owner_user", createdAt: "2026-10-01T10:00:00Z" }], access: null });
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
    mocks.users.mockReset().mockResolvedValue({ users: [{ cognitoSub: "u1", name: "Anna", email: "anna@roma.se", role: "owner_user", createdAt: "2026-10-01T10:00:00Z" }], access: null });
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

describe("Customer page Users tab: every account", () => {
  const access = { areas: ["statistik", "bokningar", "personal"], defaults: ["bokningar"], users: { s1: { add: ["personal"], remove: [] } }, version: 7 };
  const users = [
    { cognitoSub: "u1", name: "Anna", email: "anna@roma.se", role: "owner_user", status: "active", createdAt: "2026-10-01T10:00:00Z" },
    { cognitoSub: "u2", name: "Luca", email: "luca@roma.se", role: "owner_user", status: "active", invited: true, createdAt: "2026-10-02T10:00:00Z" },
    { cognitoSub: "s1", name: "Kim", email: "kim@roma.se", role: "staff_user", status: "active", locationId: "l1", phone: "+46701234567", createdAt: "2026-10-03T10:00:00Z" },
    { cognitoSub: "agent:l1", name: "Telefonassistent", email: "", role: "staff_user", status: "system", system: true, locationId: "l1" },
  ];
  const withLoc = { ...detail, locations: [{ locationId: "l1", tenantId: "t1", name: "Roma", address: "x" }],
                    tenant: { ...detail.tenant, entitlements: { maxLocations: 1, features: {} } } } as unknown as TenantDetail;
  const openUsers = async (list = users) => {
    mocks.tenant.mockReset().mockResolvedValue(withLoc);
    mocks.plans.mockReset().mockResolvedValue([]);
    mocks.users.mockReset().mockResolvedValue({ users: list, access });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Users" }));
    await screen.findByText("Kim");
  };
  const actions = (who: string) => screen.queryByRole("button", { name: `Actions for ${who}` });
  const inline = (name: string) => screen.getAllByRole("button", { name }).filter((b) => b.closest(".row-actions--inline"));

  it("gives staff the same actions as owners, and the phone assistant none", async () => {
    await openUsers();
    expect(actions("Kim")).not.toBeNull();
    expect(actions("Telefonassistent")).toBeNull();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.queryByText("Staff are invited from the admin app.")).toBeNull();
  });

  it("edits a staff user's permissions as add and remove against the group", async () => {
    mocks.updateUser.mockReset().mockResolvedValue({ user: users[2], inviteResent: false });
    await openUsers();
    await userEvent.click(inline("Edit")[2]);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector<HTMLInputElement>("input[type=checkbox]:checked")).not.toBeNull();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Bokningar" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Statistik" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.updateUser).toHaveBeenCalledWith("t1", "s1", { access: { add: ["statistik", "personal"], remove: ["bokningar"], version: 7 } });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("edits an owner's email and says the invite went again", async () => {
    mocks.updateUser.mockReset().mockResolvedValue({ user: { ...users[1], email: "l@roma.se" }, inviteResent: true });
    await openUsers();
    await userEvent.click(inline("Edit")[1]);
    const email = screen.getByRole("dialog").querySelector<HTMLInputElement>("input[type=email]")!;
    await userEvent.clear(email);
    await userEvent.type(email, "l@roma.se");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.updateUser).toHaveBeenCalledWith("t1", "u2", { email: "l@roma.se" });
    expect(await screen.findByText("Saved. Invite sent again to l@roma.se.")).toBeInTheDocument();
  });

  it("disables staff, resends an invite and removes after typing the email", async () => {
    mocks.disableUser.mockReset().mockResolvedValue({});
    mocks.resendUserInvite.mockReset().mockResolvedValue({});
    mocks.deleteUser.mockReset().mockResolvedValue({ deleted: "s1" });
    await openUsers();
    await userEvent.click(inline("Disable")[2]);
    expect(mocks.disableUser).toHaveBeenCalledWith("t1", "s1");
    expect(await screen.findByText("Kim is disabled and signed out.")).toBeInTheDocument();
    await userEvent.click(inline("Resend invite")[0]);
    expect(mocks.resendUserInvite).toHaveBeenCalledWith("t1", "u2");
    await userEvent.click(inline("Remove")[2]);
    const go = within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" });
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: /Type kim@roma.se/ }), "kim@roma.se");
    await userEvent.click(go);
    expect(mocks.deleteUser).toHaveBeenCalledWith("t1", "s1");
  });

  it("keeps the only active owner", async () => {
    await openUsers([users[0], { ...users[1], status: "disabled" }, users[2]]);
    expect(inline("Remove")[0]).toBeDisabled();
    expect(inline("Disable")[0]).toBeDisabled();
    expect(inline("Remove")[1]).toBeEnabled();
  });

  it("invites staff with location, phone and the group's permissions", async () => {
    mocks.createUser.mockReset().mockResolvedValue({ user: users[2] });
    await openUsers();
    const card = screen.getByRole("heading", { name: "Invite a user" }).closest("section")!;
    const inputs = card.querySelectorAll<HTMLInputElement>("input.input");
    await userEvent.type(inputs[0], "Sam");
    await userEvent.type(inputs[1], "sam@roma.se");
    await userEvent.type(inputs[2], "0701234567");
    await userEvent.click(screen.getByRole("checkbox", { name: "Personal" }));
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    const [tid, body] = mocks.createUser.mock.calls[0];
    expect(tid).toBe("t1");
    expect(body).toMatchObject({ role: "staff_user", name: "Sam", email: "sam@roma.se", locationId: "l1",
                                 access: { add: ["personal"], remove: [], version: 7 } });
  });
});
