import { describe, expect, it } from "vitest";
import { toneClass, trendOf } from "./trend";

describe("trendOf", () => {
  it("is green when a figure goes the good way and red the other way", () => {
    expect(trendOf(1160, 1000, "revenue", "previous period")).toEqual({
      tone: "good", direction: "up", text: "+16 %", spoken: "up 16 % vs previous period",
    });
    expect(trendOf(800, 1000, "revenue", "previous period").tone).toBe("bad");
    expect(trendOf(80, 100, "cost", "").tone).toBe("good");
    expect(trendOf(120, 100, "cost", "").tone).toBe("bad");
    expect(trendOf(4, 5, "unitCost", "").text).toBe("-20 %");
  });

  it("stays neutral without a comparison, at zero or for noise", () => {
    expect(trendOf(100, null, "revenue", "").tone).toBe("neutral");
    expect(trendOf(100, null, "revenue", "").text).toBe("");
    expect(trendOf(0, 5000, "revenue", "").text).toBe("");
    expect(trendOf(10100, 10000, "revenue", "").tone).toBe("neutral");
    expect(trendOf(1000, 1000, "revenue", "").text).toBe("unchanged");
  });

  it("counts growth from nothing as progress and a loss shrinking as better", () => {
    expect(trendOf(500, 0, "revenue", "").tone).toBe("good");
    expect(trendOf(500, 0, "revenue", "").text).toBe("new");
    expect(trendOf(50, 0, "cost", "").tone).toBe("bad");
    expect(trendOf(0, 40, "cost", "").tone).toBe("good");
    expect(trendOf(-200, -1000, "margin", "").tone).toBe("good");
    expect(trendOf(12, 10, "customers", "").text).toBe("+2");
  });

  it("gives the class that colours the figure", () => {
    expect(toneClass("good")).toBe(" trend-value--good");
    expect(toneClass("neutral")).toBe("");
  });
});
