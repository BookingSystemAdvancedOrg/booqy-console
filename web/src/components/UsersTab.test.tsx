import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ users: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import { UsersTab } from "./UsersTab";
import type { Location, Tenant } from "../types";

const tenant = { tenantId: "t1", name: "Anar", status: "active" } as Tenant;
const locations = [{ locationId: "l1", name: "Anar" }] as Location[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.users.mockResolvedValue({
    users: [
      { cognitoSub: "a", email: "own@anar.se", name: "Owner One", role: "owner_user", status: "active", phone: "+46 70 123 45 67" },
      { cognitoSub: "b", email: "staff@anar.se", name: "Staff Two", role: "staff_user", status: "active", locationId: "l1" },
    ],
    access: null,
  });
});

describe("Users tab", () => {
  it("shows each account's phone number as a call link, or a dash when there is none", async () => {
    render(<UsersTab tenant={tenant} locations={locations} />);
    const link = await screen.findByRole("link", { name: "+46 70 123 45 67" });
    expect(link).toHaveAttribute("href", "tel:+46701234567");
    expect(screen.getByRole("columnheader", { name: "Phone" })).toBeInTheDocument();
    const staffRow = screen.getByText("Staff Two").closest("tr") as HTMLElement;
    expect(within(staffRow).getByText("-", { selector: ".muted" })).toBeInTheDocument();
  });
});
