import { describe, expect, it } from "vitest";
import { addMonths, defaultFreeUntil, fmtFreeDay, freeForm, freeInput, freeLabel, stockholmToday } from "./free";

describe("free plan helpers", () => {
  it("defaults to three months from today in Stockholm", () => {
    // 23:30 UTC on 14 Nov is already 15 Nov in Stockholm
    const late = new Date("2026-11-14T23:30:00Z");
    expect(stockholmToday(late)).toBe("2026-11-15");
    expect(defaultFreeUntil(late)).toBe("2027-02-15");
    expect(defaultFreeUntil(new Date("2026-11-14T10:00:00Z"))).toBe("2027-02-14");
  });

  it("adds months and clamps to the month's last day", () => {
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2027-11-30", 3)).toBe("2028-02-29");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("labels and the no-end-date path", () => {
    expect(fmtFreeDay("2027-02-14")).toBe("14 Feb 2027");
    expect(freeLabel("2027-02-14")).toBe("Free until 14 Feb 2027");
    expect(freeLabel(null)).toBe("Free");
    const form = freeForm(null, "growth");
    expect(form.noEnd).toBe(true);
    expect(freeInput(form)).toEqual({ until: null, thenPlanId: "growth" });
    expect(freeInput({ ...form, noEnd: false, until: "2027-03-01" })).toEqual({ until: "2027-03-01", thenPlanId: "growth" });
    expect(freeForm(undefined, undefined, new Date("2026-11-14T10:00:00Z"))).toEqual({ until: "2027-02-14", noEnd: false, thenPlanId: "starter" });
  });
});
