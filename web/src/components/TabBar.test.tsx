import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reports = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("../api", () => ({
  api: {
    myAvatar: vi.fn(async () => ({ url: null })),
    supportReports: vi.fn(async () => ({ items: reports.items, cursor: null })),
  },
}));

import { api } from "../api";
import { InboxSwitch } from "./InboxSwitch";
import { TabBar, type TabSlot } from "./TabBar";

/** Phone width: matchMedia says yes to the phone query. */
function phone(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && (query.includes("max-width: 760px") || query.includes("pointer: coarse")),
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

let go: (to: string) => void = () => {};
function Nav() { go = useNavigate(); return null; }

function setup(path: string, hidden?: TabSlot[]) {
  const onSignOut = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <Nav />
      <Routes>
        <Route path="*" element={<TabBar email="anna@booqy.se" username="anna" profilePath="/settings" showInstall showDownload={false} onSignOut={onSignOut} hidden={hidden} />} />
      </Routes>
    </MemoryRouter>,
  );
  return { bar: screen.getByRole("navigation", { name: "Main" }), onSignOut };
}

const current = (bar: HTMLElement) => [...bar.querySelectorAll('[aria-current="page"]')].map((e) => e.getAttribute("aria-label"));

describe("TabBar (phones)", () => {
  beforeEach(() => { phone(true); reports.items = []; });
  afterEach(() => { vi.clearAllMocks(); document.documentElement.classList.remove("has-tabbar", "kb-open"); });

  it("has five targets, icons only, each with a name", () => {
    const { bar } = setup("/");
    const targets = [...bar.querySelectorAll("a, button")];
    expect(targets.map((t) => t.getAttribute("aria-label"))).toEqual(["Customers", "Inbox", "New customer", "Finance", "Workspace"]);
    expect(bar.textContent?.trim()).toBe("");                  // no visible words
    for (const t of targets) expect(t.querySelector("svg, .avatar")).not.toBeNull();
  });

  it("marks the page it is on, Inbox for Mail, Reports and Outbox, the avatar for its pages", () => {
    const { bar } = setup("/");
    expect(current(bar)).toEqual(["Customers"]);
    const at = (path: string) => { act(() => go(path)); return current(bar); };
    expect(at("/mail")).toEqual(["Inbox"]);
    expect(at("/reports")).toEqual(["Inbox"]);
    expect(at("/outbox")).toEqual(["Inbox"]);
    expect(at("/tenants/new")).toEqual(["New customer"]);
    expect(at("/finance")).toEqual(["Finance"]);
    expect(at("/operators")).toEqual(["Workspace"]);
    expect(at("/website")).toEqual(["Workspace"]);
    expect(at("/settings")).toEqual(["Workspace"]);
    expect(at("/tenants/t1")).toEqual([]);                     // a customer page: Customers is the home, not this
  });

  it("drops a hidden slot without a gap (four targets)", () => {
    const { bar } = setup("/", ["finance"]);
    expect([...bar.querySelectorAll("a, button")].map((t) => t.getAttribute("aria-label"))).toEqual(["Customers", "Inbox", "New customer", "Workspace"]);
  });

  it("the Workspace sheet holds everything else the old menu had", async () => {
    const { onSignOut } = setup("/");
    const you = screen.getByRole("button", { name: "Workspace" });
    fireEvent.click(you);
    expect(you).toHaveAttribute("aria-expanded", "true");
    const sheet = screen.getByRole("dialog", { name: "Workspace" });
    const names = [...sheet.querySelectorAll<HTMLElement>("a, button")].map((e) => e.textContent?.trim());
    expect(names).toEqual(["annaMy profile", "Operators", "Website", "Settings", "Search", "Install app", "Sign out"]);
    expect(document.querySelector(".main, .tabbar")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(within(sheet).getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and on the scrim, and focus goes back to the avatar", () => {
    setup("/");
    const you = screen.getByRole("button", { name: "Workspace" });
    fireEvent.click(you);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(you).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(you);
    fireEvent.click(you);
    fireEvent.click(document.querySelector(".ws-scrim")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".tabbar")?.hasAttribute("inert")).toBe(false);
  });

  it("closes when the page changes", () => {
    setup("/");
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("link", { name: "Operators" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(current(screen.getByRole("navigation", { name: "Main" }))).toEqual(["Workspace"]);
  });

  it("keeps focus inside the sheet", () => {
    setup("/");
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const rows = [...screen.getByRole("dialog").querySelectorAll<HTMLElement>("a, button")];
    rows[rows.length - 1].focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(rows[rows.length - 1]);
  });

  it("shows a dot on Inbox while reports are open", async () => {
    reports.items = [{ reportId: "r1" }];
    setup("/");
    await waitFor(() => expect(screen.getByRole("link", { name: "Inbox, open reports" })).toBeInTheDocument());
    expect(api.supportReports).toHaveBeenCalledWith("open");
  });

  it("no dot and no report calls on wide screens", async () => {
    phone(false);
    setup("/");
    await act(async () => {});
    expect(api.supportReports).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("has-tabbar")).toBe(false);
  });

  it("html.has-tabbar on phones", () => {
    setup("/");
    expect(document.documentElement.classList.contains("has-tabbar")).toBe(true);
  });
});

describe("InboxSwitch", () => {
  it("Mail and Reports, the open one current", () => {
    render(<MemoryRouter><InboxSwitch on="reports" /></MemoryRouter>);
    const group = screen.getByRole("group", { name: "Inbox" });
    expect(within(group).getByRole("link", { name: "Reports" })).toHaveAttribute("aria-current", "page");
    expect(within(group).getByRole("link", { name: "Mail" })).not.toHaveAttribute("aria-current");
  });
});
