import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { busyEnd, busyStart, resetBusyForTests, withBusy } from "../busy";
import { BusyBar } from "./BusyBar";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { act(() => resetBusyForTests()); vi.useRealTimers(); });

const bar = (c: HTMLElement) => c.querySelector(".busy-bar")!;

describe("BusyBar", () => {
  it("stays hidden for a quick answer", () => {
    const { container } = render(<BusyBar />);
    act(() => busyStart());
    act(() => { vi.advanceTimersByTime(100); });
    act(() => busyEnd());
    expect(bar(container)).toHaveClass("busy-bar--idle");
  });

  it("shows while something slow runs, then fills and fades", () => {
    const { container } = render(<BusyBar />);
    act(() => busyStart());
    act(() => { vi.advanceTimersByTime(300); });
    expect(bar(container)).toHaveClass("busy-bar--busy");
    expect(document.documentElement).toHaveClass("is-busy");
    act(() => busyEnd());
    expect(bar(container)).toHaveClass("busy-bar--done");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(bar(container)).toHaveClass("busy-bar--idle");
    expect(document.documentElement).not.toHaveClass("is-busy");
  });

  it("counts overlapping work and ends even when it fails", async () => {
    const { container } = render(<BusyBar />);
    await act(async () => {
      const failing = withBusy(() => Promise.reject(new Error("x"))).catch(() => undefined);
      busyStart();
      await failing;
    });
    act(() => { vi.advanceTimersByTime(300); });
    expect(bar(container)).toHaveClass("busy-bar--busy");     // one piece still running
    act(() => busyEnd());
    expect(bar(container)).toHaveClass("busy-bar--done");
  });
});
