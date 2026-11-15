import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tenant: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import TenantPage from "./TenantPage";

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
