import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MetaAdsSettingsCard from "./MetaAdsSettingsCard";
import MetaAdsTenantSection from "./MetaAdsTenantSection";
import { metaAdsApi } from "./api";
import { ApiError } from "../../api";

vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
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

describe("MetaAdsSettingsCard: the kill switch and the cap field", () => {
  it("the kill switch sends the saved ceiling, not an empty or decimal cap in the field", async () => {
    vi.mocked(metaAdsApi.settings).mockResolvedValue({ killSwitch: false, maxMonthlyCapSek: 20000 });
    vi.mocked(metaAdsApi.saveSettings).mockResolvedValue({ killSwitch: true, maxMonthlyCapSek: 20000 });
    render(<MetaAdsSettingsCard />);
    const field = await screen.findByLabelText(/Max monthly cap/);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn kill switch on (pause all ads)" }));
    await waitFor(() => expect(metaAdsApi.saveSettings).toHaveBeenCalledWith({ killSwitch: true, maxMonthlyCapSek: 20000 }));
    fireEvent.change(field, { target: { value: "1500.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn kill switch off" }));
    await waitFor(() => expect(metaAdsApi.saveSettings).toHaveBeenLastCalledWith({ killSwitch: false, maxMonthlyCapSek: 20000 }));
  });

  it("says the cap range once, under the field, instead of the raw code invalid_cap", async () => {
    vi.mocked(metaAdsApi.settings).mockResolvedValue({ killSwitch: false, maxMonthlyCapSek: 20000 });
    vi.mocked(metaAdsApi.saveSettings).mockRejectedValue(new ApiError(400, "invalid_cap", "Use whole kronor from 100 to 1 000 000, like 5000.", { maxMonthlyCapSek: "invalid_cap" }));
    render(<MetaAdsSettingsCard />);
    fireEvent.change(await screen.findByLabelText(/Max monthly cap/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ceiling" }));
    // Once under the field, not again in a red notice (the card's (i) tip also carries the range, inside a longer text).
    await screen.findByText("Use whole kronor from 100 to 1 000 000, like 5000.");
    expect(screen.getAllByText("Use whole kronor from 100 to 1 000 000, like 5000.")).toHaveLength(1);
    expect(document.querySelector(".notice--error")).toBeNull();
    expect(screen.queryByText("invalid_cap")).not.toBeInTheDocument();
  });

  it("is a styled, fixed-width field with the hint in the card's (i) tip, not a sub-line", async () => {
    vi.mocked(metaAdsApi.settings).mockResolvedValue({ killSwitch: false, maxMonthlyCapSek: 20000 });
    render(<MetaAdsSettingsCard />);
    const field = await screen.findByLabelText(/Max monthly cap/);
    expect(field).toHaveClass("input");
    expect(field.style.width).toBe("160px");
    expect(screen.getByRole("button", { name: "About Meta ads" })).toBeInTheDocument();
    expect(document.querySelector(".field__hint")).toBeNull();
  });

  it("shows a skeleton while loading", () => {
    vi.mocked(metaAdsApi.settings).mockReturnValue(new Promise(() => undefined));
    render(<MetaAdsSettingsCard />);
    expect(screen.getByRole("status", { name: "Loading Meta ads" })).toBeInTheDocument();
  });
});

describe("MetaAdsSettingsCard before meta-ads is deployed", () => {
  it("shows a calm empty state instead of an error", async () => {
    vi.mocked(metaAdsApi.settings).mockRejectedValue(new ApiError(404, "not_found", "This feature is not deployed in this environment"));
    render(<MetaAdsSettingsCard />);
    expect(await screen.findByText(/Meta ads is not set up in this environment yet/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("still shows other errors", async () => {
    vi.mocked(metaAdsApi.settings).mockRejectedValue(new ApiError(503, "feature_unavailable", "The feature did not answer; try again"));
    render(<MetaAdsSettingsCard />);
    expect(await screen.findByText(/didn't answer/)).toBeInTheDocument();
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

  it("shows spend as sv-SE kronor like every other console amount", async () => {
    vi.mocked(metaAdsApi.tenant).mockResolvedValue({ status: "connected", paused: false, spendThisMonthSek: 12345 });
    render(<MetaAdsTenantSection tenantId="t1" />);
    expect(await screen.findByText(/^12\s345 kr$/)).toBeInTheDocument();
    expect(screen.queryByText(/SEK/)).not.toBeInTheDocument();
  });

  it("shows a skeleton while loading", () => {
    vi.mocked(metaAdsApi.tenant).mockReturnValue(new Promise(() => undefined));
    render(<MetaAdsTenantSection tenantId="t1" />);
    expect(screen.getByRole("status", { name: "Loading Meta ads" })).toBeInTheDocument();
  });

  it("offers no pause before Meta is connected, but can lift an earlier pause", async () => {
    vi.mocked(metaAdsApi.tenant).mockResolvedValue({ status: "disconnected", paused: false, spendThisMonthSek: 0 });
    const { unmount } = render(<MetaAdsTenantSection tenantId="t1" />);
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();
    vi.mocked(metaAdsApi.tenant).mockResolvedValue({ status: "disconnected", paused: true, spendThisMonthSek: 0 });
    render(<MetaAdsTenantSection tenantId="t1" />);
    expect(await screen.findByRole("button", { name: "Resume Meta ads" })).toBeInTheDocument();
  });
});
