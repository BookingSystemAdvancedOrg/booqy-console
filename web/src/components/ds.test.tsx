import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, CtaButton, Disclosure, PaletteTrigger, type PaletteItem } from "./ds";

function setup() {
  const go = vi.fn();
  const items = (): PaletteItem[] => [
    { id: "a", group: "Actions", label: "New customer", icon: "plus", run: () => go("new") },
    { id: "n1", group: "Go to", label: "Finance", icon: "chart", run: () => go("/finance") },
    { id: "n2", group: "Go to", label: "Website", icon: "globe", run: () => go("/website") },
    { id: "r", group: "Recent", label: "Mail", icon: "mail", run: () => go("/mail") },
  ];
  render(<><PaletteTrigger /><CommandPalette items={items} /></>);
  return go;
}

describe("CommandPalette", () => {
  it("opens on Ctrl+K with a focused input and grouped results", () => {
    setup();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    for (const g of ["Actions", "Go to", "Recent"]) expect(screen.getByRole("group", { name: g })).toBeInTheDocument();
  });

  it("filters, moves with the arrows, runs on Enter and closes", () => {
    const go = setup();
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "web" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Website"]);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[3]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(go).toHaveBeenCalledWith("/mail");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Esc", () => {
    setup();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("CtaButton and Disclosure", () => {
  it("names the button by its label only", () => {
    render(<CtaButton label="Rebuild" win="Kör!" />);
    expect(screen.getByRole("button", { name: "Rebuild" })).toHaveClass("btn", "btn--primary", "cta");
  });
  it("starts closed", () => {
    render(<Disclosure title="Pages"><p>inside</p></Disclosure>);
    expect(screen.getByText("Pages").closest("details")).not.toHaveAttribute("open");
  });
});
