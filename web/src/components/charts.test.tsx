import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BarLineChart, HBarChart } from "./charts";

describe("chart tooltips", () => {
  it("names both series on hover", () => {
    const { container } = render(<BarLineChart barLabel="Revenue" lineLabel="Cost" ariaLabel="Revenue and cost"
      points={[{ key: "2026-10-01", bar: 1200, line: 300 }, { key: "2026-10-02", bar: 900, line: 250 }]} />);
    fireEvent.pointerEnter(container.querySelectorAll(".chart-hit")[1]);
    const tip = container.querySelector(".chart-tip")!;
    expect(tip.textContent).toContain("Revenue");
    expect(tip.textContent).toContain("Cost");
    expect(tip.textContent).toMatch(/900/);
    fireEvent.pointerLeave(container.querySelector("svg")!, { pointerType: "mouse" });
    expect(tip.textContent).toBe("");
  });

  it("walks the rows with the arrow keys and shows the full name", () => {
    const { container } = render(<HBarChart ariaLabel="Best margin" valueLabel="Margin"
      rows={[{ key: "a", label: "Restaurang Ett", value: 500 }, { key: "b", label: "Restaurang Två", value: -40 }]} />);
    const svg = screen.getByRole("img", { name: "Best margin" });
    fireEvent.keyDown(svg, { key: "ArrowDown" });
    fireEvent.keyDown(svg, { key: "ArrowDown" });
    const tip = container.querySelector(".chart-tip")!;
    expect(tip.textContent).toContain("Restaurang Två");
    expect(tip.textContent).toContain("Margin");
  });
});
