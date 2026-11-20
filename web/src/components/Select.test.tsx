import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectProps } from "./Select";
import { Field } from "./ui";

const FRUIT = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana", disabled: true },
  { value: "blueberry", label: "Blueberry" },
  { value: "cherry", label: "Cherry" },
];

function Harness(props: Partial<SelectProps> & { initial?: string; onPick?: (v: string) => void }) {
  const [value, setValue] = useState(props.initial ?? "apple");
  return (
    <>
      <label htmlFor="fruit">Fruit</label>
      <Select id="fruit" options={FRUIT} {...props} value={value} onChange={(v) => { setValue(v); props.onPick?.(v); }} />
      <button type="button">After</button>
    </>
  );
}

const combo = () => screen.getByRole("combobox", { name: "Fruit" });
const key = (k: string, extra: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(combo(), { key: k, ...extra });
const activeLabel = () => document.getElementById(combo().getAttribute("aria-activedescendant") ?? "")?.textContent;

afterEach(() => { vi.restoreAllMocks(); });

describe("Select", () => {
  it("is a named combobox with the value, opens a listbox in a portal and picks by click", () => {
    const onPick = vi.fn();
    const { container } = render(<Harness onPick={onPick} />);
    const c = combo();
    expect(c).toHaveTextContent("Apple");
    expect(c).toHaveAttribute("aria-expanded", "false");
    expect(c).toHaveAttribute("aria-haspopup", "listbox");
    fireEvent.click(c);
    const list = screen.getByRole("listbox", { name: "Fruit" });
    expect(container.contains(list)).toBe(false);                       // portal on body
    expect(c).toHaveAttribute("aria-controls", list.id);
    expect(screen.getByRole("option", { name: "Apple" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Banana" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("option", { name: "Banana" }));     // disabled: nothing
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Cherry" }));
    expect(onPick).toHaveBeenCalledWith("cherry");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(c).toHaveTextContent("Cherry");
    expect(c).toHaveFocus();
  });

  it("keyboard: arrows skip disabled options, Home and End, Enter picks, Escape closes and keeps focus", () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    combo().focus();
    key("ArrowDown");
    expect(combo()).toHaveAttribute("aria-expanded", "true");
    expect(activeLabel()).toBe("Apple");
    key("ArrowDown");
    expect(activeLabel()).toBe("Blueberry");                             // Banana is disabled
    key("End");
    expect(activeLabel()).toBe("Cherry");
    key("ArrowDown");
    expect(activeLabel()).toBe("Cherry");                                // stays at the end
    key("Home");
    expect(activeLabel()).toBe("Apple");
    key("ArrowDown");
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    expect(combo()).toHaveFocus();
    key("Enter");
    key("ArrowDown");
    key("Enter");
    expect(onPick).toHaveBeenCalledWith("blueberry");
    key(" ");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    key("ArrowUp", { altKey: true });                                    // Alt+Up picks and closes
    expect(screen.queryByRole("listbox")).toBeNull();
    key("ArrowDown", { altKey: true });                                  // Alt+Down opens
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    key("Tab");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("typeahead: a prefix moves to the match, a repeated letter cycles, closed typing opens on it", () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    render(<Harness />);
    combo().focus();
    key("c");
    expect(combo()).toHaveAttribute("aria-expanded", "true");
    expect(activeLabel()).toBe("Cherry");
    now += 1000;
    key("b");
    expect(activeLabel()).toBe("Blueberry");                             // Banana is disabled
    now += 1000;
    key("a");
    key("a");
    expect(activeLabel()).toBe("Apple");
    now += 1000;
    key("b"); now += 100; key("l"); now += 100; key("u");
    expect(activeLabel()).toBe("Blueberry");
    key("Enter");
    expect(combo()).toHaveTextContent("Blueberry");
  });

  it("opens under the trigger, flips above when there is no room, stays inside the window", () => {
    render(<Harness />);
    const c = combo();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    vi.spyOn(c, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 140, left: -20, right: 180, width: 200, height: 40, x: -20, y: 100, toJSON: () => ({}) });
    fireEvent.click(c);
    let list = screen.getByRole("listbox");
    expect(list.style.top).toBe("144px");
    expect(list.style.left).toBe("8px");                                 // pulled inside the edge
    expect(list.className).not.toMatch(/--up/);
    fireEvent.click(c);
    vi.spyOn(c, "getBoundingClientRect").mockReturnValue({ top: 700, bottom: 740, left: 20, right: 220, width: 200, height: 40, x: 20, y: 700, toJSON: () => ({}) });
    fireEvent.click(c);
    list = screen.getByRole("listbox");
    expect(list.style.bottom).toBe("104px");                             // 800 - 700 + 4
    expect(list.style.top).toBe("");
    expect(list.className).toMatch(/select-list--up/);
  });

  it("closes on an outside press and on a page scroll", () => {
    render(<Harness />);
    fireEvent.click(combo());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(combo());
    fireEvent.scroll(window);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("phones get a bottom sheet with a scrim that closes it", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("max-width"), media: q } as MediaQueryList));
    render(<Harness />);
    fireEvent.click(combo());
    const list = screen.getByRole("listbox");
    expect(list.className).toMatch(/select-list--sheet/);
    expect(list.getAttribute("style")).toBeNull();                      // laid out by CSS, not under the trigger
    act(() => { window.dispatchEvent(new Event("scroll")); });
    expect(screen.getByRole("listbox")).toBeInTheDocument();             // the sheet does not follow the page
    fireEvent.click(document.querySelector(".select-scrim")!);
    // the sheet slides away first (ux-motion #18), then it is gone
    expect(list).toHaveAttribute("data-closing");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("posts its value in a form and shows the placeholder when nothing is chosen", () => {
    const { container } = render(
      <form><Field label="Plan" required error="Pick a plan">
        <Select name="plan" required value="" placeholder="Choose a plan" onChange={() => {}}
                options={[{ label: "Paid", options: [{ value: "starter", label: "Starter" }, { value: "growth", label: "Growth" }] }]} />
      </Field></form>,
    );
    const c = screen.getByRole("combobox", { name: /^Plan/ });
    expect(c).toHaveTextContent("Choose a plan");
    expect(c).toHaveAttribute("aria-required", "true");
    expect(c).toHaveAttribute("aria-invalid", "true");
    expect(c).toHaveAccessibleDescription("Pick a plan");
    expect(new FormData(container.querySelector("form")!).get("plan")).toBe("");
    fireEvent.click(c);
    expect(screen.getByRole("group", { name: "Paid" })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "Plan" })).toBeInTheDocument();
  });

  it("hidden input follows a controlled value", () => {
    function Form() {
      const [v, setV] = useState("apple");
      return <form data-testid="f"><Select aria-label="Fruit" name="fruit" options={FRUIT} value={v} onChange={setV} /></form>;
    }
    render(<Form />);
    fireEvent.click(combo());
    fireEvent.click(screen.getByRole("option", { name: "Cherry" }));
    expect(new FormData(screen.getByTestId("f") as HTMLFormElement).get("fruit")).toBe("cherry");
  });

  it("disabled does not open", () => {
    render(<Harness disabled />);
    fireEvent.click(combo());
    key("ArrowDown");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(combo()).toBeDisabled();
  });
});
