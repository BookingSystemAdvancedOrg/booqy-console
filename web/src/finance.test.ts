import { describe, expect, it } from "vitest";
import {
  bucketKey, bucketSeries, customerInvoices, daysBetween, fmtPct, fmtSek, grainFor, invoiceStatus, matchesCustomer, periodBefore, periodChoices, previousSpanRange, sortRows, spanRange, topAndBottom,
} from "./finance";
import type { FinancePoint, FinanceTenantRow } from "./types";

const wed = new Date(2026, 9, 21); // Wednesday 21 October 2026

describe("billing periods (25th to 24th)", () => {
  it("lists the current period first, then the ones before it", () => {
    const choices = periodChoices(3, wed);
    expect(choices).toEqual([
      { from: "2026-09-25", to: "2026-10-24", current: true },
      { from: "2026-08-25", to: "2026-09-24", current: false },
      { from: "2026-07-25", to: "2026-08-24", current: false },
    ]);
  });
  it("the period in progress runs from the 25th to today", () => {
    expect(spanRange("2026-09-25", 1, wed)).toEqual({ from: "2026-09-25", to: "2026-10-21" });
    // 25 June to 7 July, the owner's example
    expect(spanRange("2026-06-25", 1, new Date(2026, 6, 7))).toEqual({ from: "2026-06-25", to: "2026-07-07" });
  });
  it("a past period is shown whole, and spans go back from the picked period", () => {
    expect(spanRange("2026-07-25", 1, wed)).toEqual({ from: "2026-07-25", to: "2026-08-24" });
    expect(spanRange("2026-09-25", 3, wed)).toEqual({ from: "2026-07-25", to: "2026-10-21" });
    expect(spanRange("2026-09-25", 12, wed).from).toBe("2025-10-25");
  });
  it("crosses the year and February", () => {
    expect(periodBefore("2026-01-25")).toEqual({ from: "2025-12-25", to: "2026-01-24" });
    expect(periodBefore("2026-03-25")).toEqual({ from: "2026-02-25", to: "2026-03-24" });
  });
  it("compares a period in progress with the same days of the period before", () => {
    const now = spanRange("2026-09-25", 1, wed);
    expect(previousSpanRange(now, 1)).toEqual({ from: "2026-08-25", to: "2026-09-20" });   // 27 days each
    expect(daysBetween("2026-08-25", "2026-09-20")).toBe(daysBetween(now.from, now.to));
    expect(previousSpanRange({ from: "2026-07-25", to: "2026-10-21" }, 3).from).toBe("2026-04-25");
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
    smsParts: 0, smsRevenueSek: 0, smsCostSek: 0, smsMarginSek: 0,
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
    const { addMonths } = await import("./finance");
    expect(addMonths("2026-11-01", 3)).toBe("2027-02-01");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
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

describe("billing periods from the 25th to the 24th", () => {
  it("finds the period of a day and the next one", async () => {
    const { periodOf, nextPeriod, periodText, endDateFor } = await import("./finance");
    expect(periodOf("2026-09-10")).toEqual({ start: "2026-08-25", end: "2026-09-24" });
    expect(periodOf("2026-09-25")).toEqual({ start: "2026-09-25", end: "2026-10-24" });
    expect(periodOf("2026-01-03")).toEqual({ start: "2025-12-25", end: "2026-01-24" });
    expect(nextPeriod("2026-09-24")).toEqual({ start: "2026-09-25", end: "2026-10-24" });
    expect(periodText("2026-08-25", "2026-09-24")).toBe("25 aug till 24 sep 2026");
    expect(endDateFor("trial", 3, "2026-10-21")).toBe("2026-10-24");
    expect(endDateFor("subscription", 3, "2026-10-21")).toBe("2027-01-24");
  });
});

describe("CSV export", () => {
  it("writes one row per customer with semicolons, decimal commas and quoting", async () => {
    const { customersCsv, dailyCsv, csvName } = await import("./finance");
    const row = {
      tenantId: "t1", name: "Roma; Södermalm", slug: "roma", legalName: 'Roma "AB"', orgNumber: "556000-0001", status: "active",
      billingStatus: "active", mrrSek: 990, revenueSek: 1234.5, collectedSek: 1000, creditedSek: 0, outstandingSek: 234.5, costSek: 80.25,
      costSplitSek: { baseline: 50, requests: 10.25, email: 0, sms: 20 }, marginSek: 1154.25, marginPct: 93.51, bookings: 12, orders: 3,
      requests: 900, emails: 15, sms: 10, marketingEmails: 0, smsParts: 12, smsRevenueSek: 8.4, smsCostSek: 5, smsMarginSek: 3.4,
      costPerBookingSek: 6.69, costPerOrderSek: null, activeDays: 30, invoiceCount: 1,
    } as unknown as FinanceTenantRow;
    const csv = customersCsv([row]);
    expect(csv.startsWith("﻿Customer;Legal name;")).toBe(true);
    const line = csv.split("\r\n")[1];
    expect(line).toContain('"Roma; Södermalm";"Roma ""AB""";556000-0001;active;active;990;1234,5;');
    expect(line).toContain(";93,5;12;3;");
    expect(csv.endsWith("\r\n")).toBe(true);
    const day = { day: "2026-10-01", invoicedSek: 0, paidSek: 0, costSek: 3.456, mrrSek: 990, bookings: 1, orders: 0, requests: 5,
                  activeTenants: 1 } as FinancePoint;
    expect(dailyCsv([day]).split("\r\n")[1]).toBe("2026-10-01;0;0;3,46;990;1;0;5;1;;");
    expect(csvName("daily", { from: "2026-09-25", to: "2026-10-24" })).toBe("booqy-finance-daily-2026-09-25-2026-10-24.csv");
  });
});

describe("invoice status for the operator", () => {
  it("calls an open invoice past its due date overdue", () => {
    expect(invoiceStatus({ status: "open", daysLate: 0 })).toBe("open");
    expect(invoiceStatus({ status: "open", daysLate: 3 })).toBe("overdue");
    expect(invoiceStatus({ status: "paid", daysLate: 3 })).toBe("paid");
  });

  it("sums a customer's invoices: overdue before open before paid", () => {
    expect(customerInvoices([])).toEqual({ state: "none", daysLate: 0, open: 0, latestMonth: undefined });
    expect(customerInvoices([{ status: "paid", daysLate: 0, month: "2026-09" }, { status: "paid", daysLate: 0, month: "2026-10" }]))
      .toEqual({ state: "paid", daysLate: 0, open: 0, latestMonth: "2026-10" });
    expect(customerInvoices([{ status: "paid", daysLate: 0, month: "2026-09" }, { status: "open", daysLate: 0, month: "2026-10" }]).state).toBe("open");
    expect(customerInvoices([{ status: "open", daysLate: 12, month: "2026-09" }, { status: "open", daysLate: 0, month: "2026-10" },
      { status: "void", daysLate: 40, month: "2026-08" }])).toEqual({ state: "overdue", daysLate: 12, open: 2, latestMonth: "2026-10" });
  });
});
