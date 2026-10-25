import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CountUp, Delta, deltaPct, easeOutExpo } from "./motion";
import { trendOf } from "../trend";
import { previousRange, costSplitTotals, insightTitle } from "../finance";

describe("deltas and periods", () => {
  it("compares with the previous period", () => {
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(80, 100)).toBe(-20);
    expect(deltaPct(5, 0)).toBeNull();
    expect(easeOutExpo(0)).toBe(0);
    expect(easeOutExpo(1)).toBe(1);
    expect(easeOutExpo(0.5)).toBeGreaterThan(0.9);
    expect(previousRange("2026-10-01", "2026-10-21")).toEqual({ from: "2026-09-10", to: "2026-09-30" });
    expect(costSplitTotals([{ costSplitSek: { baseline: 1, requests: 2, email: 3, sms: 4 } }, { costSplitSek: { baseline: 1, requests: 1, email: 0, sms: 0 } }]))
      .toEqual({ requests: 3, baseline: 2, email: 3, sms: 4 });
    expect(insightTitle("Revenue", 12.34)).toBe("Revenue: 12,3 % up");
    expect(insightTitle("Revenue", -3)).toBe("Revenue: 3 % down");
    expect(insightTitle("Revenue", null)).toBe("Revenue");
  });

  it("renders the trend stamp and the count-up's final value under reduced motion", () => {
    const { container } = render(<>
      <Delta trend={trendOf(1200, 1000, "revenue", "previous period")} />
      <Delta trend={trendOf(1200, 1000, "cost", "previous period")} />
      <Delta trend={trendOf(null, 100, "revenue", "previous period")} />
      <strong><CountUp value={2980} format={(n) => `${Math.round(n)} kr`} /></strong>
    </>);
    const stamps = [...container.querySelectorAll(".delta")];
    expect(stamps[0]).toHaveClass("delta--good");
    expect(stamps[0]).toHaveTextContent("+20");
    expect(stamps[1]).toHaveClass("delta--bad");
    expect(stamps[0].querySelector(".sr-only")?.textContent).toBe("up 20\u00a0% vs previous period");
    expect(screen.getByText("no comparison yet")).toBeInTheDocument();
    expect(screen.getByText("2980 kr")).toBeInTheDocument();
  });
});
