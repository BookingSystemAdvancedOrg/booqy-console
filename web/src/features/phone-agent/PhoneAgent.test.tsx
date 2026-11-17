import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PhoneAgentSettingsCard from "./PhoneAgentSettingsCard";
import PhoneAgentTenantSection from "./PhoneAgentTenantSection";
import { phoneAgentApi } from "./api";
import { ApiError } from "../../api";

vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), phoneAgentApi: { settings: vi.fn(), saveSettings: vi.fn(), tenant: vi.fn(), setPaused: vi.fn() } }));

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

  it("shows Not connected, without an error or a pause, before any location is set up", async () => {
    vi.mocked(phoneAgentApi.tenant).mockResolvedValue({ paused: false, locations: [], usage: [] });
    render(<PhoneAgentTenantSection tenantId="t1" />);
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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

  it("the kill switch sends the saved ceiling, not an empty cap in the field", async () => {
    vi.mocked(phoneAgentApi.settings).mockResolvedValue({ killSwitch: false, maxMinutesCap: 1000 });
    vi.mocked(phoneAgentApi.saveSettings).mockResolvedValue({ killSwitch: true, maxMinutesCap: 1000 });
    render(<PhoneAgentSettingsCard />);
    const field = await screen.findByLabelText(/Max minutes/);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn kill switch on (stop all calls)" }));
    expect(await screen.findByText(/The kill switch is ON/)).toBeInTheDocument();
    expect(phoneAgentApi.saveSettings).toHaveBeenCalledWith({ killSwitch: true, maxMinutesCap: 1000 });
  });

  it("says the cap range once, under the field, instead of the raw code invalid_cap", async () => {
    vi.mocked(phoneAgentApi.settings).mockResolvedValue({ killSwitch: false, maxMinutesCap: 1000 });
    vi.mocked(phoneAgentApi.saveSettings).mockRejectedValue(new ApiError(400, "invalid_cap", "Use whole minutes from 0 to 100000, like 600.", { maxMinutesCap: "invalid_cap" }));
    render(<PhoneAgentSettingsCard />);
    fireEvent.change(await screen.findByLabelText(/Max minutes/), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ceiling" }));
    await screen.findByText(/Use whole minutes from 0 to 100000/);
    expect(screen.getAllByText(/Use whole minutes from 0 to 100000/)).toHaveLength(1);
    expect(document.querySelector(".notice--error")).toBeNull();
    expect(screen.queryByText("invalid_cap")).not.toBeInTheDocument();
  });

  it("is a styled, fixed-width field with the hint in the card's (i) tip", async () => {
    vi.mocked(phoneAgentApi.settings).mockResolvedValue({ killSwitch: false, maxMinutesCap: 1000 });
    render(<PhoneAgentSettingsCard />);
    const field = await screen.findByLabelText(/Max minutes/);
    expect(field).toHaveClass("input");
    expect(field.style.width).toBe("160px");
    expect(screen.getByRole("button", { name: "About Phone agent" })).toBeInTheDocument();
    expect(document.querySelector(".field__hint")).toBeNull();
  });

  it("shows a skeleton while loading", () => {
    vi.mocked(phoneAgentApi.settings).mockReturnValue(new Promise(() => undefined));
    render(<PhoneAgentSettingsCard />);
    expect(screen.getByRole("status", { name: "Loading the phone agent" })).toBeInTheDocument();
  });
});
