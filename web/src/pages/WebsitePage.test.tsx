import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { websiteFixture } from "../test/websiteFixture";

const mocks = vi.hoisted(() => ({ website: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import WebsitePage from "./WebsitePage";

const renderPage = () => render(<MemoryRouter><WebsitePage /></MemoryRouter>);

beforeEach(() => mocks.website.mockReset().mockResolvedValue(websiteFixture()));

describe("WebsitePage", () => {
  it("shows the KPIs with green and red against the previous period", async () => {
    renderPage();
    const lead = await screen.findByRole("region", { name: "Visitors and demo bookings" });
    expect(within(lead).getByText("Demo bookings")).toBeInTheDocument();
    expect(within(lead).getAllByText(/\+13 %|\+14 %/).length).toBeGreaterThan(0);
    const engagement = screen.getByRole("region", { name: "Engagement" });
    // a lower bounce rate is good
    expect(within(engagement).getByText(/^48,2\s%$/).className).toContain("trend-value--good");
    expect(screen.getByText(/3 visitors in the last 30 min/)).toBeInTheDocument();
  });

  it("lists sources, campaigns and places", async () => {
    renderPage();
    expect(await screen.findByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Campaigns (UTM)", { selector: "td span" })).toBeInTheDocument();
    expect(screen.getByText("host-2026")).toBeInTheDocument();
    expect(screen.getByText("Sweden (SE)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cities" }));
    expect(screen.getByText("Göteborg, SE")).toBeInTheDocument();
  });

  it("asks for the chosen period and a custom range", async () => {
    renderPage();
    await screen.findByText("Search");
    expect(mocks.website).toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.any(String), to: expect.any(String) }));
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    const [{ from, to }] = mocks.website.mock.lastCall!;
    expect((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000).toBe(6);
    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(screen.getByLabelText("From")).toHaveValue(from);
  });

  it("explains an empty site and an environment without statistics", async () => {
    const zero = { visitors: 0, visits: 0, pageviews: 0, conversions: 0, convertedVisits: 0, conversionRate: null, bounceRate: null, avgEngagedSeconds: null, pagesPerVisit: null };
    mocks.website.mockResolvedValue(websiteFixture({ kpis: zero, previousKpis: null, live: null }));
    renderPage();
    expect(await screen.findByText("No visits counted yet")).toBeInTheDocument();
    mocks.website.mockResolvedValue({ enabled: false });
    renderPage();
    expect(await screen.findByText(/Statistics are off/)).toBeInTheDocument();
  });
});
