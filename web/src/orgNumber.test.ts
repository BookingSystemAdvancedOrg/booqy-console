import { describe, expect, it } from "vitest";
import { orgNumberProblem, vatFromOrgNumber, vatPreview } from "./orgNumber";

describe("vatPreview", () => {
  it("follows the org. number digit by digit and adds 01 when complete", () => {
    expect(vatPreview("")).toBe("");
    expect(vatPreview("5")).toBe("SE5");
    expect(vatPreview("556012-34")).toBe("SE55601234");
    expect(vatPreview("556012-3456")).toBe("SE556012345601");
  });

  it("only the complete number is ever saved", () => {
    expect(vatFromOrgNumber("556012-34")).toBe("");
    expect(vatFromOrgNumber("5560123456")).toBe("SE556012345601");
  });
});

describe("orgNumberProblem", () => {
  it("flags a wrong check digit", () => {
    expect(orgNumberProblem("556000-0002")).toBeTruthy();
    expect(orgNumberProblem("556012-3456")).toBeUndefined();
  });
});
