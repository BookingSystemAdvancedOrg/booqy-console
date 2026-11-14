import { describe, expect, it, vi } from "vitest";
import { fillLive, resolveLive } from "./live";

describe("live numbers", () => {
  it("picks singular for 1 and plural otherwise", () => {
    const text = "There {is|are} {value} {customer|customers}.";
    expect(fillLive(text, { shown: "1", count: 1 })).toBe("There is 1 customer.");
    expect(fillLive(text, { shown: "2", count: 2 })).toBe("There are 2 customers.");
    expect(fillLive(text, { shown: "0", count: 0 })).toBe("There are 0 customers.");
    expect(fillLive("{value} {message|messages}", { shown: "more than 250", count: Infinity })).toBe("more than 250 messages");
  });

  it("counts customers with the right form", async () => {
    const tenants = vi.fn().mockResolvedValue([{ status: "active" }]);
    const src = { tenants, financeOverview: vi.fn(), outbox: vi.fn() } as unknown as Parameters<typeof resolveLive>[1];
    expect(await resolveLive({ metric: "activeCustomers", text: "{value} {customer is|customers are} active right now." }, src)).toBe(
      "1 customer is active right now.",
    );
  });

  it("prefers countText and keeps text plain for older clients", async () => {
    const tenants = vi.fn().mockResolvedValue([{ status: "active" }]);
    const src = { tenants, financeOverview: vi.fn(), outbox: vi.fn() } as unknown as Parameters<typeof resolveLive>[1];
    const live = { metric: "activeCustomers", text: "{value} customers are active.", countText: "{value} {customer is|customers are} active." };
    expect(await resolveLive(live, src)).toBe("1 customer is active.");
  });

  it("keeps every corpus text free of {one|many} so older clients never show the braces", async () => {
    const { KB } = await import("./kb");
    for (const entry of KB.entries) {
      if (entry.live) expect(entry.live.text, entry.id).not.toMatch(/\{[^{}]*\|[^{}]*\}/);
    }
  });
});
