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
    act(() => { vi.advanceTimersByTime(SCROLL_IDLE_MS + 50); });
    expect(btn).not.toHaveClass("is-away");
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
});
