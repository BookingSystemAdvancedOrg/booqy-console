import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PhoneAgentSettingsCard from "./PhoneAgentSettingsCard";
import PhoneAgentTenantSection from "./PhoneAgentTenantSection";
import { phoneAgentApi } from "./api";
import { ApiError } from "../../api";

vi.mock("./api", () => ({ phoneAgentApi: { settings: vi.fn(), saveSettings: vi.fn(), tenant: vi.fn(), setPaused: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe("PhoneAgentTenantSection", () => {
  it("shows numbers, minutes and pauses the tenant", async () => {
    vi.mocked(phoneAgentApi.tenant).mockResolvedValue({ paused: false, usage: [{ periodEnd: "2026-11-24", minutes: 42 }],
      locations: [{ locationId: "loc-1", enabled: true, number: "+46100000001", minutesThisPeriod: 42 }] });
    vi.mocked(phoneAgentApi.setPaused).mockResolvedValue({ paused: true });
    render(<PhoneAgentTenantSection tenantId="t1" />);
    expect(await screen.findByText("+46100000001")).toBeInTheDocument();
    expect(screen.getByText("Until 2026-11-24")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause phone agent" }));
    expect(await screen.findByText(/Paused by an operator/)).toBeInTheDocument();
    expect(phoneAgentApi.setPaused).toHaveBeenCalledWith("t1", true);
  });

  it("is calm before the feature is deployed", async () => {
    vi.mocked(phoneAgentApi.tenant).mockRejectedValue(new ApiError(404, "not_found", "x"));
    render(<PhoneAgentTenantSection tenantId="t1" />);
    expect(await screen.findByText(/not set up in this environment/)).toBeInTheDocument();
  });
});

describe("PhoneAgentSettingsCard", () => {
  it("turns the platform kill switch on", async () => {
    vi.mocked(phoneAgentApi.settings).mockResolvedValue({ killSwitch: false, maxMinutesCap: 1000 });
    vi.mocked(phoneAgentApi.saveSettings).mockResolvedValue({ killSwitch: true, maxMinutesCap: 1000 });
    render(<PhoneAgentSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn kill switch on (stop all calls)" }));
    expect(await screen.findByText(/The kill switch is ON/)).toBeInTheDocument();
    expect(phoneAgentApi.saveSettings).toHaveBeenCalledWith({ killSwitch: true, maxMinutesCap: 1000 });
  });
});
