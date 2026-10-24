import { describe, expect, it } from "vitest";
import { breakdownsCsv, campaignParts, countryName, dailyCsv, fmtDuration, lastDays, placeParts, scrollReach, share } from "./website";
import { websiteFixture } from "./test/websiteFixture";

describe("website helpers", () => {
  it("presets end today and include it", () => {
    expect(lastDays(7, new Date(2026, 9, 25))).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(lastDays(30, new Date(2026, 9, 25))).toEqual({ from: "2026-09-26", to: "2026-10-25" });
  });
  it("splits campaign and place keys", () => {
    expect(campaignParts("facebook|paid|host")).toEqual({ source: "facebook", medium: "paid", campaign: "host" });
    expect(campaignParts("|email|")).toEqual({ source: "-", medium: "email", campaign: "-" });
    expect(placeParts("SE|Västra Götalands län")).toEqual({ country: "SE", place: "Västra Götalands län" });
    expect(countryName("SE")).toBe("Sweden");
  });
  it("formats durations and shares", () => {
    expect(fmtDuration(42)).toBe("42 s");
    expect(fmtDuration(65)).toBe("1 min 05 s");
    expect(fmtDuration(null)).toBe("-");
    expect(share(1, 4)).toBe(25);
    expect(share(1, 0)).toBeNull();
  });
  it("scroll reach counts every band at or below the depth reached", () => {
    const r = scrollReach({ "0": 1, "25": 1, "50": 0, "75": 1, "100": 1 });
    expect(r.map((x) => x.pct)).toEqual([75, 50, 50, 25]);
  });
  it("exports CSV for Swedish Excel", () => {
    const data = websiteFixture();
    const daily = dailyCsv(data);
    expect(daily.startsWith("﻿Day;Visitors;Visits;Page views;Demo bookings\r\n")).toBe(true);
    expect(daily.split("\r\n")).toHaveLength(32);
    const b = breakdownsCsv(data);
    expect(b).toContain("Source;search;980;3;0,3;42,9;;");
    expect(b).toContain("Page;/demo;;;;;420;95");
  });
});
