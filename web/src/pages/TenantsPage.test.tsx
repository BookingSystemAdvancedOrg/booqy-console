import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tenants: vi.fn(), financeInvoices: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import TenantsPage from "./TenantsPage";

const tenants = [
  { tenantId: "t1", name: "Pizzeria Roma", slug: "roma", status: "active", planId: "starter", locationCount: 1, maxLocations: 3,
    chargesEnabled: true, ownerEmail: "roma@example.test", primaryDomain: "roma.example.test", createdAt: "2026-09-01T10:00:00Z" },
  { tenantId: "t2", name: "Krogen Norr", slug: "norr", status: "provisioning_failed", planId: "growth", locationCount: 0,
    chargesEnabled: false, createdAt: "2026-11-01T10:00:00Z" },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<TenantsPage />} />
        <Route path="/tenants/:id" element={<p>Customer page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenants.mockResolvedValue(tenants);
  mocks.financeInvoices.mockResolvedValue({ invoices: [] });
});

const cardOf = async (name: string) => (await screen.findByText(name)).closest("tr") as HTMLTableRowElement;

describe("Customers list as phone cards", () => {
  it("gives each card a heading, a status badge and the key facts with their labels", async () => {
    renderPage();
    const card = await cardOf("Pizzeria Roma");
    expect(card.querySelector(".cell-title")).toHaveTextContent("Pizzeria Roma");
    expect(card.querySelector(".cell-title")).toHaveTextContent("roma@example.test");
    expect(card.querySelector(".cell-badge .status")).toBeInTheDocument();
    const facts = Object.fromEntries([...card.querySelectorAll("td.cell-fact")].map((td) => [td.getAttribute("data-label"), td.textContent]));
    expect(facts).toEqual({ Plan: "starter", Invoices: "-", Locations: "1 / 3" });
  });

  it("labels every other cell and leaves the details for the customer page on phones", async () => {
    renderPage();
    const card = await cardOf("Pizzeria Roma");
    const hidden = [...card.querySelectorAll("td.phone-hide")].map((td) => td.getAttribute("data-label"));
    expect(hidden).toEqual(["Payments", "Site", "Created"]);
    // every cell is either the heading, the badge or labelled
    for (const td of card.querySelectorAll("td")) {
      expect(td.matches(".cell-title, .cell-badge, [data-label]")).toBe(true);
    }
  });

  it("opens the customer when the card is tapped anywhere", async () => {
    renderPage();
    const card = await cardOf("Pizzeria Roma");
    await userEvent.click(card.querySelector('td[data-label="Locations"]')!);
    expect(await screen.findByText("Customer page")).toBeInTheDocument();
  });

  it("names the card by the restaurant for keyboards and screen readers", async () => {
    renderPage();
    expect(await screen.findByRole("link", { name: "Pizzeria Roma" })).toHaveAttribute("href", "/tenants/t1");
  });

  it("keeps a short, centred empty state when the search finds nothing", async () => {
    renderPage();
    await screen.findByText("Pizzeria Roma");
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "zzz");
    const empty = document.querySelector("td.empty");
    expect(empty).toHaveTextContent("No customers match. Add one");
  });

  it("shows every status filter with its count", async () => {
    renderPage();
    await screen.findByText("Pizzeria Roma");
    const chips = [...document.querySelectorAll(".chips .chip")];
    expect(chips).toHaveLength(7);
    expect(chips.find((c) => c.textContent?.includes("Setup failed"))).toHaveTextContent("1");
  });
});

describe("phone table styles", () => {
  const css = readFileSync(resolve(__dirname, "../phoneTables.css"), "utf8");
  it("turns tables into cards only at phone width and wraps the chips", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 640px) {"));
    expect(phone).toContain(".table.table > thead { display: none; }");
    expect(phone).toContain("content: attr(data-label)");
    expect(phone).toContain('[data-glide="track"] { flex-wrap: wrap !important');
    expect(css.indexOf("@media (max-width: 640px) {")).toBeLessThan(css.indexOf(".table.table"));
  });
});
