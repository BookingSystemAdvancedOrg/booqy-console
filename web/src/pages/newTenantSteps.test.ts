import { describe, expect, it } from "vitest";
import { STEPS, progressPct, stepOfField, stepProblems, type StepInput } from "./newTenantSteps";

const blank: StepInput = {
  name: "", slug: "", ownerName: "", ownerEmail: "", contactEmail: "", billingEmail: "", replyToEmail: "",
  planId: "", locationCount: 1, maxLocations: 1,
};

describe("progressPct", () => {
  it("is front-loaded: half for the first step, half of what is left for each next, full at the last", () => {
    expect(STEPS).toHaveLength(6);
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => progressPct(n))).toEqual([0, 50, 75, 87.5, 93.75, 96.875, 100]);
  });
  it("works for any number of steps", () => {
    expect(progressPct(1, 2)).toBe(50);
    expect(progressPct(2, 2)).toBe(100);
    expect(progressPct(3, 3)).toBe(100);
    expect(progressPct(9, 3)).toBe(100);
    expect(progressPct(1, 0)).toBe(0);
  });
});

describe("stepProblems", () => {
  it("asks for the name and slug, and a valid org. number", () => {
    expect(stepProblems("company", blank)).toEqual({ name: "Required", slug: "Required" });
    expect(stepProblems("company", { ...blank, name: "Roma", slug: "roma", orgProblem: "check digit" })).toEqual({ orgNumber: "check digit" });
    expect(stepProblems("company", { ...blank, name: "Roma", slug: "roma" })).toEqual({});
  });
  it("asks for the owner's name and a real email", () => {
    expect(stepProblems("owner", blank)).toEqual({ ownerName: "Required", ownerEmail: "Required" });
    expect(stepProblems("owner", { ...blank, ownerName: "Lamo", ownerEmail: "lamo@" })).toEqual({ ownerEmail: "Not an email address" });
    expect(stepProblems("owner", { ...blank, ownerName: "Lamo", ownerEmail: "lamo@roma.se" })).toEqual({});
  });
  it("lets contact be empty but checks emails that are typed", () => {
    expect(stepProblems("contact", blank)).toEqual({});
    expect(stepProblems("contact", { ...blank, billingEmail: "nope" })).toEqual({ billingEmail: "Not an email address" });
  });
  it("needs a plan, and no more locations than allowed", () => {
    expect(stepProblems("plan", blank)).toEqual({ planId: "Pick a plan" });
    expect(stepProblems("plan", { ...blank, planId: "starter" })).toEqual({});
    expect(Object.keys(stepProblems("locations", { ...blank, locationCount: 2 }))).toEqual(["locations"]);
    expect(stepProblems("notes", blank)).toEqual({});
  });
});

describe("stepOfField", () => {
  it("finds the step of every field the API names", () => {
    expect(stepOfField("address.city")).toBe(0);
    expect(stepOfField("ownerEmail")).toBe(1);
    expect(stepOfField("replyToEmail")).toBe(2);
    expect(stepOfField("overrides.limits.phoneAgentMinutesPerMonth")).toBe(3);
    expect(stepOfField("billing.priceSek")).toBe(3);
    expect(stepOfField("locations.0.name")).toBe(4);
    expect(stepOfField("notes")).toBe(5);
    expect(stepOfField("other")).toBe(-1);
  });
});
