import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tenants: vi.fn(), financeInvoices: vi.fn(), plans: vi.fn() }));
vi.mock("../api", () => ({ api: mocks, ApiError: class extends Error {} }));

import TenantsPage, { matchesSearch } from "./TenantsPage";

const tenants = [
  { tenantId: "t1", name: "Pizzeria Roma", slug: "roma", status: "active", planId: "starter", locationCount: 1, maxLocations: 3,
    chargesEnabled: true, ownerEmail: "roma@example.test", primaryDomain: "roma.example.test", createdAt: "2026-09-01T10:00:00Z",
    orgNumber: "559123-4567" },
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
  mocks.plans.mockResolvedValue([{ planId: "starter", name: "Starter", maxLocations: 3, features: {} }]);
});

const cardOf = async (name: string) => (await screen.findByText(name)).closest("tr") as HTMLTableRowElement;

describe("Customers when the list fails", () => {
  it("shows the error with Try again, not an empty list", async () => {
    mocks.tenants.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderPage();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(/No customers match/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Pizzeria Roma")).toBeInTheDocument();
  });
});

describe("Customers list as phone cards", () => {
  it("gives each card a heading, a status badge and the key facts with their labels", async () => {
    renderPage();
    const card = await cardOf("Pizzeria Roma");
    expect(card.querySelector(".cell-title")).toHaveTextContent("Pizzeria Roma");
    expect(card.querySelector(".cell-title")).toHaveTextContent("roma@example.test");
    expect(card.querySelector(".cell-badge .status")).toBeInTheDocument();
    const facts = Object.fromEntries([...card.querySelectorAll("td.cell-fact")].map((td) => [td.getAttribute("data-label"), td.textContent]));
    expect(facts).toEqual({ Plan: "Starter", Invoices: "-", Locations: "1 / 3" });
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
    await userEvent.type(screen.getByLabelText("Search customers"), "zzz");
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

describe("Status filter (one pill beside the search where the chips do not fit)", () => {
  it("shows the chosen status with its count and lists every status with its count", async () => {
    renderPage();
    await screen.findByText("Pizzeria Roma");
    const pill = screen.getByRole("combobox", { name: "Status filter" });
    expect(pill).toHaveTextContent("Active1");
    await userEvent.click(pill);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["All2", "Active1", "Setting up", "Setup failed1", "Suspended", "Offboarded", "Data deleted"]);
  });

  it("filters the list by the chosen status", async () => {
    renderPage();
    await screen.findByText("Pizzeria Roma");
    await userEvent.click(screen.getByRole("combobox", { name: "Status filter" }));
    await userEvent.click(screen.getByRole("option", { name: /^Setup failed/ }));
    expect(screen.getByRole("combobox", { name: "Status filter" })).toHaveTextContent("Setup failed1");
    expect(await screen.findByRole("link", { name: "Krogen Norr" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Pizzeria Roma" })).not.toBeInTheDocument();
    // the chip bar follows the same choice
    expect(document.querySelector(".chips .chip--on")).toHaveTextContent("Setup failed");
  });

  it("keeps the chip bar for wide pages and hides it where the pill shows (styles.css)", () => {
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
    const q = css.slice(css.indexOf("@container tenants-toolbar"));
    expect(css).toContain(".tenants-toolbar { container: tenants-toolbar / inline-size; }");
    expect(q).toContain(".tenants-toolbar > .chips { display: none !important; }");
    expect(q).toContain(".tenants-filter { display: block; flex: 0 1 auto; min-width: 0; max-width: min(55%, calc(100% - 132px)); }");
    // the search keeps its room next to a long status (320 px, "Data deleted")
    expect(q).toMatch(/\.input\.search \{[^}]*min-width: 120px/);
    expect(css).toMatch(/\.status-filter \.select__label \{[^}]*text-overflow: ellipsis/);
    expect(css).toMatch(/\.input\.select\.status-filter \{[^}]*min-height: 44px/);
  });
});

describe("Search", () => {
  const roma = tenants[0] as Parameters<typeof matchesSearch>[0];
  it("matches name, slug, owner email and domain", () => {
    for (const q of ["roma", "ROMA", "roma@example", "example.test"]) expect(matchesSearch(roma, q)).toBe(true);
    expect(matchesSearch(roma, "norr")).toBe(false);
  });
  it("matches the org. number with or without the dash", () => {
    for (const q of ["559123-4567", "5591234567", "5591234", "  5591234567 "]) expect(matchesSearch(roma, q)).toBe(true);
    expect(matchesSearch(roma, "5591239999")).toBe(false);
    expect(matchesSearch({ ...roma, orgNumber: undefined }, "5591234567")).toBe(false);
  });
  it("finds a customer by org. number in the list", async () => {
    renderPage();
    await screen.findByText("Pizzeria Roma");
    await userEvent.type(screen.getByLabelText("Search customers"), "5591234567");
    expect(screen.getByRole("link", { name: "Pizzeria Roma" })).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Search customers"));
    await userEvent.type(screen.getByLabelText("Search customers"), "559123-4567");
    expect(screen.getByRole("link", { name: "Pizzeria Roma" })).toBeInTheDocument();
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
  it("makes Customers rows slim on phones: the name and a small status, nothing else", async () => {
    renderPage();
    const card = await cardOf("Pizzeria Roma");
    expect(card.closest("table")).toHaveClass("table--slim");
    const slim = css.slice(css.indexOf(".table--slim (the Customers list)"));
    expect(slim).toContain(".table.table--slim > tbody > tr > td:not(.cell-title):not(.cell-badge):not(.empty) { display: none; }");
    expect(slim).toContain(".table.table--slim > tbody > tr > td.cell-title > :not(.row-link__name) { display: none; }");
    expect(slim).toMatch(/min-height: 52px/);
    // what is left on the phone row: the name link and the badge
    expect(card.querySelector(".cell-title > .row-link__name")).toHaveTextContent("Pizzeria Roma");
    expect(card.querySelector(".cell-badge .status")).toHaveTextContent("Active");
  });
  it("stacks long values, keeps the you tag whole and leaves room for the Ask Booqy button", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 640px) {"));
    expect(phone).toMatch(/td\.cell-stack::before \{ float: none; display: block;/);
    expect(phone).toContain(".operator-name .tag { flex: none; white-space: nowrap; }");
    expect(phone).toContain("margin-bottom: 72px");
    expect(css.slice(0, css.indexOf("@media (max-width: 640px) {"))).toContain(".web-sub { display: none; }");
  });
});

describe("Customers when the invoices fail (finding 191)", () => {
  it("shows the error with Try again and '?' instead of '-' in Invoices", async () => {
    mocks.financeInvoices.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderPage();
    const card = await cardOf("Pizzeria Roma");
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(card.querySelector('td[data-label="Invoices"]')).toHaveTextContent("?");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Pizzeria Roma")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect((await cardOf("Pizzeria Roma")).querySelector('td[data-label="Invoices"]')).toHaveTextContent("-");
  });
});

describe("Plan column (finding 211)", () => {
  it("shows the plan's name, and the id capitalised for a plan not in the list", async () => {
    mocks.plans.mockResolvedValue([{ planId: "starter", name: "Starter Plus", maxLocations: 3, features: {} }]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "All" }));
    expect((await cardOf("Pizzeria Roma")).querySelector('td[data-label="Plan"]')).toHaveTextContent(/^Starter Plus$/);
    expect((await cardOf("Krogen Norr")).querySelector('td[data-label="Plan"]')).toHaveTextContent(/^Growth$/);
  });
});
