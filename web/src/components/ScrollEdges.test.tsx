import { describe, expect, it } from "vitest";
import { edgesOf } from "./ScrollEdges";

describe("ScrollEdges", () => {
  it("marks the sides that have more to scroll", () => {
    expect(edgesOf({ scrollLeft: 0, scrollWidth: 500, clientWidth: 500 })).toBe("");
    expect(edgesOf({ scrollLeft: 0, scrollWidth: 800, clientWidth: 500 })).toBe("right");
    expect(edgesOf({ scrollLeft: 120, scrollWidth: 800, clientWidth: 500 })).toBe("left right");
    expect(edgesOf({ scrollLeft: 300, scrollWidth: 800, clientWidth: 500 })).toBe("left");
  });
});
