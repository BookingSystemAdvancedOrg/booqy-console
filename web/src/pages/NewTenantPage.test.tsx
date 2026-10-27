import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  plans: vi.fn(), createTenant: vi.fn(), tenant: vi.fn(), updateTenant: vi.fn(), retryOnboarding: vi.fn(),
}));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import NewTenantPage, { setupFailure } from "./NewTenantPage";

const OWNER_TAKEN = "OwnerEmailInUse: The owner email is already registered to another tenant (t-9). Use a different address for this tenant.";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/new"]}>
      <Routes>
        <Route path="/new" element={<NewTenantPage />} />
        <Route path="/tenants/:id" element={<p>customer page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillAndCreate() {
  await screen.findByText("Starter");
  fireEvent.change(document.getElementById("f-name")!, { target: { value: "Test Pizza" } });
  fireEvent.change(document.getElementById("f-ownerName")!, { target: { value: "Lamo" } });
  fireEvent.change(document.getElementById("f-ownerEmail")!, { target: { value: "taken@example.se" } });
  fireEvent.click(document.getElementById("f-planId")!);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create customer" })); });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.plans.mockResolvedValue([{ planId: "starter", name: "Starter", maxLocations: 1, features: {}, priceSek: 499 }]);
  mocks.createTenant.mockResolvedValue({ tenantId: "t1", status: "provisioning" });
});
afterEach(() => vi.useRealTimers());

describe("setupFailure", () => {
  it("points a taken owner email at its field", () => {
    expect(setupFailure(OWNER_TAKEN).fields).toEqual({ ownerEmail: expect.stringContaining("another customer") });
    expect(setupFailure("Stripe.Error: card declined")).toEqual({ fields: {}, message: "card declined" });
  });
});

describe("NewTenantPage", () => {
  it("prints while setting up, then opens the customer", async () => {
    mocks.tenant.mockResolvedValue({ tenant: { status: "active" } });
    renderPage();
    await fillAndCreate();
    expect(screen.getByRole("status", { name: "Setting up Test Pizza" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(screen.getByText("customer page")).toBeInTheDocument();
  });

  it("goes back to the form with the owner email highlighted, then saves and retries", async () => {
    mocks.tenant.mockResolvedValue({ tenant: { status: "provisioning_failed", lastError: OWNER_TAKEN } });
    mocks.updateTenant.mockResolvedValue({ tenant: {} });
    mocks.retryOnboarding.mockResolvedValue({ status: "provisioning" });
    renderPage();
    await fillAndCreate();
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    const email = document.getElementById("f-ownerEmail")!;
    expect(email.closest(".field")).toHaveClass("field--error");
    expect(screen.getByText(/Setup stopped/)).toBeInTheDocument();
    expect(document.getElementById("f-slug")).toBeDisabled();
    fireEvent.change(email, { target: { value: "new@example.se" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save and retry" })); });
    expect(mocks.updateTenant).toHaveBeenCalledWith("t1", expect.objectContaining({ ownerEmail: "new@example.se", name: "Test Pizza" }));
    expect(mocks.retryOnboarding).toHaveBeenCalledWith("t1");
    expect(mocks.createTenant).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status", { name: "Setting up Test Pizza" })).toBeInTheDocument();
  });
});
