import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GoogleBusinessTenantSection from "./GoogleBusinessTenantSection";
import { googleBusinessApi } from "./api";
import { ApiError } from "../../api";

vi.mock("./api", () => ({ googleBusinessApi: { tenant: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe("GoogleBusinessTenantSection", () => {
  it("shows the connection and each linked location", async () => {
    vi.mocked(googleBusinessApi.tenant).mockResolvedValue({ status: "connected", links: [
      { locationId: "loc-1", title: "Bistro Södermalm", syncStatus: "ok", lastSyncAt: "2026-11-04T13:05:00.000Z" }] });
    render(<GoogleBusinessTenantSection tenantId="t1" />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Bistro Södermalm")).toBeInTheDocument();
    expect(screen.getByText("In sync")).toBeInTheDocument();
    expect(googleBusinessApi.tenant).toHaveBeenCalledWith("t1");
  });

  it("says so when nothing is linked", async () => {
    vi.mocked(googleBusinessApi.tenant).mockResolvedValue({ status: "disconnected", links: [] });
    render(<GoogleBusinessTenantSection tenantId="t1" />);
    expect(await screen.findByText("No location is linked to a Google location.")).toBeInTheDocument();
  });

  it("shows a calm empty state before the feature is deployed", async () => {
    vi.mocked(googleBusinessApi.tenant).mockRejectedValue(new ApiError(404, "not_found", "not deployed"));
    render(<GoogleBusinessTenantSection tenantId="t1" />);
    expect(await screen.findByText(/not set up in this environment yet/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
