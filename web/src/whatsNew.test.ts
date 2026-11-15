import { describe, expect, it } from "vitest";
import { BUILT_N, WHATS_NEW, latestN } from "./whatsNew";

// The rule in whatsNew.ts: unique, increasing n and short texts without dashes.
describe("whatsNew.ts", () => {
  it("has unique, increasing whole n, newest last", () => {
    WHATS_NEW.forEach((e, i) => {
      expect(Number.isInteger(e.n) && e.n > 0).toBe(true);
      if (i > 0) expect(e.n).toBeGreaterThan(WHATS_NEW[i - 1].n);
    });
  });

  it("keeps every text short (2 to 40 characters) and free of em and en dashes", () => {
    for (const e of WHATS_NEW) {
      expect(e.text).toBe(e.text.trim());
      expect(e.text.length).toBeGreaterThanOrEqual(2);
      expect(e.text.length).toBeLessThanOrEqual(40);
      expect(e.text).not.toMatch(/[–—]|&[mn]dash;/);
    }
  });

  it("embeds the highest n in the build", () => {
    expect(BUILT_N).toBe(latestN(WHATS_NEW));
  });
});
