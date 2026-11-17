import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import SettingsPage from "./SettingsPage";

vi.mock("../features/meta-ads/api", () => ({ metaAdsApi: { settings: () => Promise.reject(new Error("offline")) } }));
vi.mock("../features/phone-agent/api", () => ({ phoneAgentApi: { settings: () => Promise.reject(new Error("offline")) } }));

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname + search}</p>;
}

const at = (entry: string) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

describe("SettingsPage", () => {
  it("sends the old #profile address to the profile page", async () => {
    at("/settings#profile");
    expect((await screen.findByTestId("where")).textContent).toBe("/profile");
  });

  it("sends #mail-brand to the brand template tab in Mail", async () => {
    at("/settings#mail-brand");
    expect((await screen.findByTestId("where")).textContent).toBe("/mail?tab=brand-template");
  });

  it("keeps branches at their #address and names the appearance card only once on screen", async () => {
    at("/settings#appearance");
    // The branch title shows; the card keeps the same name for screen readers only.
    const titles = await screen.findAllByRole("heading", { level: 2, name: "Appearance and sound" });
    expect(titles.map((h) => h.className)).toEqual(["stree-title", "sr-only"]);
    expect(screen.getByRole("region", { name: "Appearance and sound" })).toBeInTheDocument();
    expect(screen.queryByTestId("where")).toBeNull();
  });
});
