import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CountUp, Delta, deltaPct } from "./motion";
import { previousRange, costSplitTotals, insightTitle } from "../finance";

describe("deltas and periods", () => {
  it("compares with the previous period", () => {
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(80, 100)).toBe(-20);
    expect(deltaPct(5, 0)).toBeNull();
    expect(previousRange("2026-10-01", "2026-10-21")).toEqual({ from: "2026-09-10", to: "2026-09-30" });
    expect(costSplitTotals([{ costSplitSek: { baseline: 1, requests: 2, email: 3, sms: 4 } }, { costSplitSek: { baseline: 1, requests: 1, email: 0, sms: 0 } }]))
      .toEqual({ requests: 3, baseline: 2, email: 3, sms: 4 });
    expect(insightTitle("Revenue", 12.34)).toBe("Revenue: 12,3 % up");
    expect(insightTitle("Revenue", -3)).toBe("Revenue: 3 % down");
    expect(insightTitle("Revenue", null)).toBe("Revenue");
  });

  it("renders the delta stamp and the count-up's final value under reduced motion", () => {
    render(<>
      <Delta current={120} previous={100} />
      <Delta current={120} previous={100} invert />
      <Delta current={1} previous={0} />
      <strong><CountUp value={2980} format={(n) => `${Math.round(n)} kr`} /></strong>
    </>);
    const stamps = screen.getAllByText(/vs previous period/).map((e) => e.closest(".delta"));
    expect(stamps[0]).toHaveClass("delta--good");
    expect(stamps[1]).toHaveClass("delta--bad");
    expect(screen.getByText("nothing in the previous period")).toBeInTheDocument();
    expect(screen.getByText("2980 kr")).toBeInTheDocument();
  });
});
