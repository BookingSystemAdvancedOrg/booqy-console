import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MetaAdsSettingsCard from "./MetaAdsSettingsCard";
import MetaAdsTenantSection from "./MetaAdsTenantSection";
import { metaAdsApi } from "./api";

vi.mock("./api", () => ({
  metaAdsApi: { settings: vi.fn(), saveSettings: vi.fn(), tenant: vi.fn(), setPaused: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

describe("MetaAdsSettingsCard", () => {
  it("turns the kill switch on with the current ceiling", async () => {
    vi.mocked(metaAdsApi.settings).mockResolvedValue({ killSwitch: false, maxMonthlyCapSek: 20000 });
    vi.mocked(metaAdsApi.saveSettings).mockResolvedValue({ killSwitch: true, maxMonthlyCapSek: 20000 });
    render(<MetaAdsSettingsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn kill switch on (pause all ads)" }));
    await waitFor(() => expect(metaAdsApi.saveSettings).toHaveBeenCalledWith({ killSwitch: true, maxMonthlyCapSek: 20000 }));
    expect(await screen.findByText(/The kill switch is ON/)).toBeInTheDocument();
  });

  it("saves a new ceiling", async () => {
    vi.mocked(metaAdsApi.settings).mockResolvedValue({ killSwitch: false, maxMonthlyCapSek: 20000 });
    vi.mocked(metaAdsApi.saveSettings).mockResolvedValue({ killSwitch: false, maxMonthlyCapSek: 5000 });
    render(<MetaAdsSettingsCard />);
    fireEvent.change(await screen.findByLabelText(/Max monthly cap/), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ceiling" }));
    await waitFor(() => expect(metaAdsApi.saveSettings).toHaveBeenCalledWith({ killSwitch: false, maxMonthlyCapSek: 5000 }));
  });
});

describe("MetaAdsTenantSection", () => {
  it("shows the connection and pauses the tenant", async () => {
    vi.mocked(metaAdsApi.tenant).mockResolvedValue({ status: "connected", adAccountId: "act_1", pageId: "p1", paused: false, spendThisMonthSek: 1200 });
    vi.mocked(metaAdsApi.setPaused).mockResolvedValue({ paused: true });
    render(<MetaAdsTenantSection tenantId="t1" />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("act_1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause Meta ads" }));
    await waitFor(() => expect(metaAdsApi.setPaused).toHaveBeenCalledWith("t1", true));
    expect(await screen.findByRole("button", { name: "Resume Meta ads" })).toBeInTheDocument();
  });
});
