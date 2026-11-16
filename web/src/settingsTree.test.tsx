import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BRANCHES, BRANCH_LABEL, LEAVES, TREES, searchLeaves } from "./settingsTree";
import { SettingsTreeNav } from "./components/SettingsTree";

describe("settings tree", () => {
  it("gives every branch one tree and keeps #desktop-app", () => {
    expect([...BRANCHES].sort()).toEqual(Object.keys(BRANCH_LABEL).sort());
    expect(new Set(BRANCHES).size).toBe(BRANCHES.length);
    expect(BRANCHES).toContain("desktop-app");
    for (const leaf of LEAVES) expect(BRANCHES, leaf.label).toContain(leaf.branch);
  });

  it("finds settings by label and keyword", () => {
    expect(searchLeaves("dark", () => true)[0].branch).toBe("appearance");
    expect(searchLeaves("kill", () => true).map((l) => l.branch)).toEqual(["meta-ads", "phone-agent"]);
    expect(searchLeaves("logo", () => true)[0].branch).toBe("mail-brand");
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
});
