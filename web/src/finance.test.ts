import { describe, expect, it } from "vitest";
import {
  bucketKey, bucketSeries, daysBetween, fmtPct, fmtSek, grainFor, matchesCustomer, presetRange, sortRows, topAndBottom,
} from "./finance";
import type { FinancePoint, FinanceTenantRow } from "./types";

const wed = new Date(2026, 9, 21); // Wednesday 21 October 2026

describe("presetRange", () => {
  it("week starts on Monday and ends today", () => {
    expect(presetRange("week", wed)).toEqual({ from: "2026-10-19", to: "2026-10-21" });
  });
  it("month, quarter and year start on their first day", () => {
    expect(presetRange("month", wed)).toEqual({ from: "2026-10-01", to: "2026-10-21" });
    expect(presetRange("quarter", wed)).toEqual({ from: "2026-10-01", to: "2026-10-21" });
    expect(presetRange("quarter", new Date(2026, 1, 5))).toEqual({ from: "2026-01-01", to: "2026-02-05" });
    expect(presetRange("year", wed)).toEqual({ from: "2026-01-01", to: "2026-10-21" });
  });
  it("last 30 days counts today as one of them", () => {
    const r = presetRange("last30", wed);
    expect(r).toEqual({ from: "2026-09-22", to: "2026-10-21" });
    expect(daysBetween(r.from, r.to)).toBe(30);
  });
});

describe("formatting", () => {
  it("formats SEK the Swedish way", () => {
    const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
    expect(plain(fmtSek(12345))).toBe("12 345 kr");
    expect(plain(fmtSek(4.349, { decimals: true }))).toBe("4,35 kr");
    expect(fmtSek(null)).toBe("-");
    expect(plain(fmtSek(0))).toBe("0 kr");
    expect(plain(fmtPct(96.5))).toBe("96,5 %");
  });
});

describe("series", () => {
  it("picks the grain from the range length", () => {
    expect(grainFor(7)).toBe("day");
    expect(grainFor(90)).toBe("week");
    expect(grainFor(365)).toBe("month");
  });
  it("buckets days into weeks (Monday) and months", () => {
    expect(bucketKey("2026-10-21", "week")).toBe("2026-10-19");
    expect(bucketKey("2026-10-19", "week")).toBe("2026-10-19");
    expect(bucketKey("2026-10-21", "month")).toBe("2026-10-01");
  });
  it("sums revenue and cost, keeps the last MRR snapshot", () => {
    const series: FinancePoint[] = [
      { day: "2026-10-19", invoicedSek: 100, paidSek: 50, costSek: 10, mrrSek: 900, bookings: 1, orders: 0, requests: 5, activeTenants: 1 },
      { day: "2026-10-20", invoicedSek: 200, paidSek: 0, costSek: 15, mrrSek: 990, bookings: 2, orders: 1, requests: 5, activeTenants: 1 },
      { day: "2026-10-26", invoicedSek: 1, paidSek: 0, costSek: 1, mrrSek: 1000, bookings: 0, orders: 0, requests: 0, activeTenants: 1 },
    ];
    const weeks = bucketSeries(series, "week");
    expect(weeks.map((b) => b.key)).toEqual(["2026-10-19", "2026-10-26"]);
    expect(weeks[0]).toMatchObject({ revenue: 300, collected: 50, cost: 25, mrr: 990, bookings: 3, orders: 1 });
  });
});

function row(name: string, marginSek: number, extra: Partial<FinanceTenantRow> = {}): FinanceTenantRow {
  return {
    tenantId: name, name, slug: name.toLowerCase(), status: "active", billingStatus: "active", mrrSek: 0, revenueSek: 0,
    collectedSek: 0, creditedSek: 0, outstandingSek: 0, costSek: 0, costSplitSek: { baseline: 0, requests: 0, email: 0, sms: 0 },
    marginSek, marginPct: null, bookings: 0, orders: 0, requests: 0, emails: 0, sms: 0, marketingEmails: 0,
    costPerBookingSek: null, costPerOrderSek: null, activeDays: 0, invoiceCount: 0, ...extra,
  };
}

describe("months", () => {
  it("gives a month's range and neighbours", async () => {
    const { monthRange, shiftMonth, monthLabel } = await import("./finance");
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-10")).toBe("Oktober 2026");
  });
});

describe("rows", () => {
  it("splits top and bottom only when there are enough customers", () => {
    const rows = [row("A", 5), row("B", 1), row("C", -2)];
    expect(topAndBottom(rows, 5)).toEqual({ top: [rows[0], rows[1], rows[2]], bottom: [] });
    const many = Array.from({ length: 12 }, (_, i) => row(`T${i}`, i));
    const { top, bottom } = topAndBottom(many, 5);
    expect(top.map((t) => t.marginSek)).toEqual([11, 10, 9, 8, 7]);
    expect(bottom.map((t) => t.marginSek)).toEqual([0, 1, 2, 3, 4]);
  });
  it("sorts by number or by name", () => {
    const rows = [row("Örjans", 1, { revenueSek: 10 }), row("Anna", 3, { revenueSek: 30 }), row("Bo", 2, { revenueSek: 20 })];
    expect(sortRows(rows, "revenueSek", "desc").map((r) => r.name)).toEqual(["Anna", "Bo", "Örjans"]);
    expect(sortRows(rows, "name", "asc").map((r) => r.name)).toEqual(["Anna", "Bo", "Örjans"]);
  });
  it("matches a customer by name, org number or slug", () => {
    const t = { name: "Pizzeria Roma", legalName: "Roma Restaurang AB", orgNumber: "556677-8899", slug: "pizzeria-roma" };
    expect(matchesCustomer(t, "roma")).toBe(true);
    expect(matchesCustomer(t, "5566778899")).toBe(true);
    expect(matchesCustomer(t, "556677-88")).toBe(true);
    expect(matchesCustomer(t, "linnea")).toBe(false);
    expect(matchesCustomer(t, "")).toBe(true);
  });
});
