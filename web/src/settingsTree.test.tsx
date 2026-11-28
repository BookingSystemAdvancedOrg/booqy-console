import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BRANCHES, BRANCH_LABEL, LEAVES, MOVED, TREES, buildApples, isBranch, isTree, searchLeaves, type BranchId, type TreeId } from "./settingsTree";
import { BranchHead, BranchPager, SettingsField, SettingsTreeNav, SettingsTreePage, useViewFocus } from "./components/SettingsTree";

describe("settings tree", () => {
  it("gives every branch one tree and keeps #desktop-app", () => {
    expect([...BRANCHES].sort()).toEqual(Object.keys(BRANCH_LABEL).sort());
    expect(new Set(BRANCHES).size).toBe(BRANCHES.length);
    expect(BRANCHES).toContain("desktop-app");
    for (const leaf of LEAVES) {
      if (leaf.branch) expect(BRANCHES, leaf.label).toContain(leaf.branch);
      else expect(TREES.find((t) => t.id === leaf.tree)?.links?.map((l) => l.to), leaf.label).toContain(leaf.to);
    }
  });

  it("makes Profile and the email brand template links, and sends their old #addresses there", () => {
    expect(BRANCHES).not.toContain("profile");
    expect(BRANCHES).not.toContain("mail-brand");
    const links = TREES.flatMap((t) => t.links ?? []).map((l) => l.to);
    expect(links).toEqual(expect.arrayContaining(["/profile", "/mail?tab=brand-template", "/operators"]));
    expect(MOVED).toEqual({ profile: "/profile", "mail-brand": "/mail?tab=brand-template" });
    for (const to of Object.values(MOVED)) expect(links).toContain(to);
  });

  it("finds settings by label and keyword", () => {
    expect(searchLeaves("dark", () => true)[0].branch).toBe("appearance");
    expect(searchLeaves("kill", () => true).map((l) => l.branch)).toEqual(["meta-ads", "phone-agent"]);
    expect(searchLeaves("logo", () => true)[0].to).toBe("/mail?tab=brand-template");
    expect(searchLeaves("avatar", () => true)[0].to).toBe("/profile");
    expect(searchLeaves("", () => true)).toEqual([]);
  });

  it("is a keyboard tree with the current branch marked", async () => {
    const user = userEvent.setup();
    const onBranch = vi.fn();
    render(<SettingsTreeNav trees={TREES} current="appearance" currentTree="you" onBranch={onBranch} onLink={() => {}} />);
    const current = screen.getByRole("treeitem", { name: "Appearance and sound" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveAttribute("tabindex", "0");
    current.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onBranch).toHaveBeenCalledWith("desktop-app");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("treeitem", { name: "You" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("treeitem", { name: "You" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "Profile" })).toBeNull();
  });

  it("opens the linked pages from the tree and the field card", async () => {
    const user = userEvent.setup();
    const onLink = vi.fn();
    render(<SettingsTreeNav trees={TREES} current={null} currentTree={null} onBranch={() => {}} onLink={onLink} />);
    await user.click(screen.getByRole("treeitem", { name: "Profile" }));
    await user.click(screen.getByRole("treeitem", { name: "Email brand template" }));
    expect(onLink.mock.calls.map((c) => c[0])).toEqual(["/profile", "/mail?tab=brand-template"]);
  });
});

const field = (apples = {}) =>
  render(<SettingsField trees={TREES} apples={apples} visible={() => true} onTree={() => {}} onBranch={() => {}} onLeaf={() => {}} onLink={() => {}} />);

describe("settings field", () => {
  it("lists the linked pages on the card, with an arrow, and opens them", async () => {
    const user = userEvent.setup();
    const onLink = vi.fn();
    render(<SettingsField trees={TREES} apples={{}} visible={() => true} onTree={() => {}} onBranch={() => {}} onLeaf={() => {}} onLink={onLink} />);
    const profile = screen.getByRole("button", { name: "Profile" });
    expect(profile.querySelector("svg")).not.toBeNull();
    await user.click(profile);
    await user.click(screen.getByRole("button", { name: "Email brand template" }));
    expect(onLink.mock.calls.map((c) => c[0])).toEqual(["/profile", "/mail?tab=brand-template"]);
  });

  it("gives every tree a real h2 heading with the button inside it", () => {
    field();
    for (const t of TREES) {
      const heading = screen.getByRole("heading", { level: 2, name: t.label });
      expect(heading.closest("button"), t.label).toBeNull();
      expect(within(heading).getByRole("button", { name: t.label })).toBeInTheDocument();
      expect(heading.closest("section")).toHaveAttribute("aria-labelledby", heading.id);
    }
  });

  it("shows no empty listbox when the search has no hits, and announces the count", async () => {
    const user = userEvent.setup();
    field();
    const box = screen.getByRole("combobox", { name: "Search settings" });
    await user.type(box, "zzzz");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
    await user.clear(box);
    await user.type(box, "kill");
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("2 matches");
  });

  it("draws a green dot only for what is running, nothing for preferences, amber for a kill switch", () => {
    const apples = buildApples({ theme: "light", sound: false, meta: { killSwitch: false }, phone: { killSwitch: true, maxMinutesCap: 60 } });
    const tone = Object.fromEntries(Object.values(apples).flat().map((a) => [a!.text, a!.tone ?? "neutral"]));
    expect(tone).toEqual({ Light: "neutral", "Sound off": "neutral", "Meta ads running": "ok", "Phone agent paused": "warn" });
    expect(buildApples({ theme: "dark", sound: true, meta: { killSwitch: true }, phone: { killSwitch: false, maxMinutesCap: 60 } }).platform)
      .toEqual([{ text: "Meta ads paused by kill switch", branch: "meta-ads", tone: "warn" }, { text: "Phone cap 60 min", branch: "phone-agent", tone: "ok" }]);
    expect(buildApples({ theme: "dark", sound: true, meta: null, phone: { killSwitch: false } }).platform)
      .toEqual([]);
    field(apples);
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("class", "stree-apple");
    expect(screen.getByRole("button", { name: "Meta ads running" })).toHaveAttribute("class", "stree-apple ok");
    expect(screen.getByRole("button", { name: "Phone agent paused" })).toHaveAttribute("class", "stree-apple warn");
  });
});

/** The page's views (field, tree, branch) as in SettingsPage, with the same focus rule. */
function Views() {
  const [view, setView] = useState("");
  const body = useRef<HTMLDivElement>(null);
  useViewFocus(view, body);
  const go = (to: BranchId | TreeId | null) => setView(to ?? "");
  const tree = isTree(view) ? TREES.find((t) => t.id === view) : undefined;
  return (
    <div ref={body}>
      {view === "" && <SettingsField trees={TREES} apples={{}} visible={() => true} onTree={go} onBranch={go} onLeaf={(l) => go(l.branch ?? null)} onLink={() => {}} />}
      {tree && <SettingsTreePage tree={tree} apples={[]} onField={() => go(null)} onBranch={go} onLink={() => {}} />}
      {isBranch(view) && <BranchHead key={view} branch={view} onField={() => go(null)} onTree={go} />}
      {isBranch(view) && <BranchPager order={BRANCHES} branch={view} onBranch={go} />}
    </div>
  );
}

describe("focus follows the view", () => {
  it("moves to the new heading, and back to where you came from", async () => {
    const user = userEvent.setup();
    render(<Views />);
    screen.getByRole("button", { name: "Appearance and sound" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { level: 2, name: "Appearance and sound" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: BRANCH_LABEL["desktop-app"] }));
    expect(screen.getByRole("heading", { level: 2, name: BRANCH_LABEL["desktop-app"] })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: BRANCH_LABEL["desktop-app"] })).toHaveFocus();
    screen.getByRole("button", { name: "Platform" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { level: 2, name: "Platform" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: BRANCH_LABEL["phone-agent"] }));
    expect(screen.getByRole("heading", { level: 2, name: BRANCH_LABEL["phone-agent"] })).toHaveFocus();
    await user.click(screen.getAllByRole("button", { name: /Platform/ })[0]);
    expect(screen.getByRole("button", { name: BRANCH_LABEL["phone-agent"] })).toHaveFocus();
    await user.click(screen.getAllByRole("button", { name: /Settings/ })[0]);
    expect(screen.getByRole("button", { name: "Platform" })).toHaveFocus();
  });
});
