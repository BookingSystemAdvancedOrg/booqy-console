import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BackButton } from "./ds";

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe("BackButton", () => {
  it("is a link with the label as its name", () => {
    render(<MemoryRouter><BackButton to="/">Customers</BackButton></MemoryRouter>);
    const link = screen.getByRole("link", { name: "Customers" });
    expect(link).toHaveAttribute("href", "/");
    expect(link).toHaveClass("btn", "back-btn");
    expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("is a button that says Back without a label", async () => {
    const onClick = vi.fn();
    render(<BackButton onClick={onClick} />);
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

// Back controls are always BackButton: never a text link, an arrow glyph or crumbs.
describe("no plain back controls", () => {
  it("finds no old back patterns", () => {
    const bad: string[] = [];
    for (const f of sourceFiles(SRC)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const at = `${relative(SRC, f)}:${i + 1}`;
        // A chip that picks "Back to the card" (refunds) is not navigation.
        if (line.includes("<BackButton") || line.includes("chip") || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/>\s*(←|&larr;|Back\b)/.test(line) || /^\s*Back to\b/.test(line)) bad.push(at);
        if (/className="(?:crumbs|stree-back|link back)"/.test(line)) bad.push(at);
      });
    }
    expect(bad).toEqual([]);
  });
});
