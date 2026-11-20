import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exitMs, originIn, stagger, useClosing } from "./motion";
import { celebrate, claimOnce } from "./Celebrate";
import { rubberBand } from "./WorkspaceSheet";

const motion = (reduce: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("stagger (ux-motion #3)", () => {
  it("steps per item and stops at the cap", () => {
    expect(stagger(0)).toBe(0);
    expect(stagger(2)).toBe(80);
    expect(stagger(6)).toBe(240);
    expect(stagger(40)).toBe(240);
    expect(stagger(-3)).toBe(0);
    expect(stagger(10, 20, 8)).toBe(160);
  });
});

describe("originIn (ux-motion #11)", () => {
  it("puts the origin on the trigger's centre inside the overlay box", () => {
    const trigger = document.createElement("button");
    const box = document.createElement("div");
    document.body.append(trigger, box);
    trigger.getBoundingClientRect = () => rect(300, 500, 40, 20);
    box.getBoundingClientRect = () => rect(100, 200, 400, 300);
    expect(originIn(trigger, box)).toBe("220px 310px");
    trigger.remove(); box.remove();
  });

  it("gives up for a missing, detached or hidden trigger", () => {
    const box = document.createElement("div");
    expect(originIn(null, box)).toBeNull();
    expect(originIn(document.createElement("button"), box)).toBeNull();   // not in the page
    const hidden = document.createElement("button");
    document.body.append(hidden);
    hidden.getBoundingClientRect = () => rect(0, 0, 0, 0);
    expect(originIn(hidden, box)).toBeNull();
    hidden.remove();
  });
});

describe("useClosing (ux-motion #18)", () => {
  it("marks closing, then calls onClose after the exit time, once", () => {
    motion(false);
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { result } = renderHook(() => useClosing(onClose));
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1]());   // a second close while leaving does nothing
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(130); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(result.current[0]).toBe(false);
  });

  it("closes at once with reduced motion", () => {
    motion(true);
    const onClose = vi.fn();
    const { result } = renderHook(() => useClosing(onClose));
    expect(exitMs()).toBe(0);
    act(() => result.current[1]());
    expect(onClose).toHaveBeenCalledOnce();
    expect(result.current[0]).toBe(false);
  });
});

describe("rubberBand (ux-motion #13)", () => {
  it("moves less than the drag and never past the size", () => {
    expect(rubberBand(0, 400)).toBe(0);
    expect(rubberBand(-20, 400)).toBe(0);
    const small = rubberBand(40, 400), big = rubberBand(4000, 400);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(40);
    expect(big).toBeLessThan(400);
    expect(rubberBand(80, 400)).toBeGreaterThan(small);
  });
});

describe("celebrate (ux-motion #19)", () => {
  beforeEach(() => { sessionStorage.clear(); motion(false); });

  it("claims an id once per session", () => {
    expect(claimOnce("live:t1")).toBe(true);
    expect(claimOnce("live:t1")).toBe(false);
    expect(claimOnce("live:t2")).toBe(true);
  });

  it("pops the element for a step and fires an id only once", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    expect(celebrate(el, "step", "zone:x.se")).toBe(true);
    expect(el).toHaveClass("celebrate--step");
    vi.advanceTimersByTime(1200);
    expect(el).not.toHaveClass("celebrate--step");
    expect(celebrate(el, "step", "zone:x.se")).toBe(false);
    expect(el).not.toHaveClass("celebrate--step");
  });

  it("does not move anything with reduced motion", () => {
    motion(true);
    const el = document.createElement("div");
    expect(celebrate(el, "finish")).toBe(true);
    expect(el.className).toBe("");
    expect(document.querySelector(".confetti-layer")).toBeNull();
  });
});
