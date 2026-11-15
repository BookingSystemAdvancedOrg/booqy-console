import { useRef } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCROLL_IDLE_MS, useDodge } from "./dodge";

function Launcher() {
  const ref = useRef<HTMLButtonElement>(null);
  useDodge(ref, true);
  return <button ref={ref} type="button" className="help-launcher">Ask Booqy</button>;
}

let under: Element[] = [];
const scrollTo = (y: number) => {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  window.dispatchEvent(new Event("scroll"));
};

beforeEach(() => {
  vi.useFakeTimers();
  under = [];
  document.elementsFromPoint = () => under;
  scrollTo(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Ask Booqy launcher", () => {
  it("slides away while scrolling down and is back after a pause", () => {
    const { getByRole } = render(<Launcher />);
    const btn = getByRole("button");
    act(() => { vi.advanceTimersByTime(50); });
    expect(btn).not.toHaveClass("is-away");
    act(() => { scrollTo(200); vi.advanceTimersByTime(50); });
    expect(btn).toHaveClass("is-away");
    expect(btn).toHaveClass("is-scrolling");
    act(() => { vi.advanceTimersByTime(SCROLL_IDLE_MS + 50); });
    expect(btn).not.toHaveClass("is-away");
    expect(btn).not.toHaveClass("is-scrolling");
  });

  it("comes back at once on a scroll up", () => {
    const { getByRole } = render(<Launcher />);
    const btn = getByRole("button");
    act(() => { scrollTo(300); vi.advanceTimersByTime(50); });
    expect(btn).toHaveClass("is-away");
    act(() => { scrollTo(250); vi.advanceTimersByTime(50); });
    expect(btn).not.toHaveClass("is-away");
  });

  it("never rests on top of a control", () => {
    const control = document.createElement("button");
    document.body.appendChild(control);
    under = [control];
    const { getByRole } = render(<Launcher />);
    act(() => { vi.advanceTimersByTime(50); });
    expect(getByRole("button", { name: "Ask Booqy" })).toHaveClass("is-away");
    control.remove();
  });

  it("stays in the tab order over a control and shows on focus", () => {
    const control = document.createElement("button");
    document.body.appendChild(control);
    under = [control];
    const { getByRole } = render(<Launcher />);
    const btn = getByRole("button", { name: "Ask Booqy" });
    act(() => { vi.advanceTimersByTime(50); });
    expect(btn).toHaveClass("is-away");
    expect(btn).not.toHaveClass("is-scrolling");
    act(() => { btn.focus(); });
    expect(btn).not.toHaveClass("is-away");
    act(() => { btn.blur(); });
    expect(btn).toHaveClass("is-away");
    control.remove();
  });
});
