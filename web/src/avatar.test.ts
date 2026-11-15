import { describe, expect, it } from "vitest";
import { coverCrop, initials } from "./avatar";

describe("profile pictures", () => {
  it("makes initials from the name, else the e-mail", () => {
    expect(initials("Lamo Kouravand", "x@y.se")).toBe("LK");
    expect(initials("Zach", null)).toBe("Z");
    expect(initials("", "arya@ithjalparna.se")).toBe("A");
    expect(initials(null, null)).toBe("?");
  });

  it("covers the square and centres a wide picture", () => {
    const c = coverCrop(400, 200, 240, 1, 0, 0);
    expect(c.scale).toBeCloseTo(1.2);
    expect(c.y).toBe(0);
    expect(c.x).toBeCloseTo(-120);
  });

  it("never lets the picture leave a gap in the square", () => {
    const c = coverCrop(400, 200, 240, 1, 999, -999);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
    const d = coverCrop(400, 200, 240, 1, -999, 0);
    expect(d.x).toBeCloseTo(240 - 400 * 1.2);
  });

  it("zoom scales up from the cover size", () => {
    expect(coverCrop(300, 300, 240, 2, 0, 0).scale).toBeCloseTo(1.6);
  });
});
