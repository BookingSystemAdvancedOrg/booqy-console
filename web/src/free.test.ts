import { describe, expect, it } from "vitest";
import { addMonths, defaultFreeUntil, fmtFreeDay, formUntil, freeInput, freeLabel, freeProblems, newFreeForm, presetUntil,
         savedFreeForm, stockholmToday } from "./free";

describe("free plan helpers", () => {
  it("defaults to three months from today in Stockholm", () => {
    // 23:30 UTC on 14 Nov is already 15 Nov in Stockholm
    const late = new Date("2026-11-14T23:30:00Z");
    expect(stockholmToday(late)).toBe("2026-11-15");
    expect(defaultFreeUntil(late)).toBe("2027-02-14");
    expect(defaultFreeUntil(new Date("2026-11-14T10:00:00Z"))).toBe("2027-02-13");
  });

  it("3 and 6 months end the day before the same date, month ends clamped; until changed has no end", () => {
    expect(presetUntil("3m", "2026-11-14")).toBe("2027-02-13");           // first paid day 14 Feb
    expect(presetUntil("6m", "2026-11-14")).toBe("2027-05-13");           // first paid day 14 May
    expect(presetUntil("3m", "2026-11-30")).toBe("2027-02-27");           // first paid day 28 Feb
    expect(presetUntil("6m", "2026-08-31")).toBe("2027-02-27");
    expect(presetUntil("3m", "2027-11-30")).toBe("2028-02-28");           // leap year: first paid 29 Feb
    expect(presetUntil("until_changed", "2026-11-14")).toBeNull();
  });

  it("adds months and clamps to the month's last day", () => {
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2027-11-30", 3)).toBe("2028-02-29");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("needs the plan and a price above 0 after a timed preset, nothing after until changed", () => {
    const form = newFreeForm();
    expect(form).toEqual({ preset: "3m", thenPlanId: "" });
    expect(freeProblems(form, "")).toEqual({ thenPlanId: "Pick the plan after Free", price: "Set the monthly price after Free" });
    expect(freeProblems({ ...form, thenPlanId: "starter" }, "0")).toEqual({ price: "Set the monthly price after Free" });
    expect(freeProblems({ ...form, preset: "6m", thenPlanId: "growth" }, "450")).toEqual({});
    expect(freeProblems({ ...form, preset: "until_changed" }, "")).toEqual({});
  });

  it("sends the preset, or an older customer's own date as it is", () => {
    expect(freeInput({ preset: "3m", thenPlanId: "growth" })).toEqual({ preset: "3m", thenPlanId: "growth" });
    expect(freeInput({ preset: "until_changed", thenPlanId: "" })).toEqual({ preset: "until_changed" });
    expect(freeInput({ preset: null, thenPlanId: "growth", keptUntil: "2027-03-01" })).toEqual({ until: "2027-03-01", thenPlanId: "growth" });
  });

  it("reads saved Free customers: stored preset, no end, matching dates, or an own date", () => {
    expect(savedFreeForm({ freePreset: "6m", freeUntil: "2027-05-13", freeThenPlanId: "growth" }))
      .toEqual({ preset: "6m", thenPlanId: "growth", keptUntil: "2027-05-13" });
    expect(savedFreeForm({ freeUntil: null, freeThenPlanId: "growth" })).toEqual({ preset: "until_changed", thenPlanId: "growth" });
    expect(savedFreeForm({ freeUntil: "2027-02-13", freeSince: "2026-11-14", freeThenPlanId: "starter" }).preset).toBe("3m");
    expect(savedFreeForm({ freeUntil: "2027-02-20", freeSince: "2026-11-14", freeThenPlanId: "starter" }))
      .toEqual({ preset: null, thenPlanId: "starter", keptUntil: "2027-02-20" });
  });

  it("shows the saved end while the preset is unchanged, else the one computed from the start", () => {
    const saved = { preset: "3m" as const, thenPlanId: "starter", keptUntil: "2027-03-01" };
    expect(formUntil(saved, "2026-11-14", saved)).toBe("2027-03-01");
    expect(formUntil({ ...saved, preset: "6m" }, "2026-11-14", saved)).toBe("2027-05-13");
    expect(formUntil({ ...saved, preset: "until_changed" }, "2026-11-14", saved)).toBeNull();
    expect(formUntil({ preset: null, thenPlanId: "x", keptUntil: "2027-04-04" }, "2026-11-14")).toBe("2027-04-04");
  });

  it("labels", () => {
    expect(fmtFreeDay("2027-02-14")).toBe("14 Feb 2027");
    expect(freeLabel("2027-02-14")).toBe("Free until 14 Feb 2027");
    expect(freeLabel(null)).toBe("Free");
  });
});
