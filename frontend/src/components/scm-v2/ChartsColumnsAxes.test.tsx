/* Owner 2026-11-05 (Project Overview: 别分开，我就想要一个表罢了): one chart, with the
   amount scale on the left, the line's % scale on the right, and every figure of a
   column on hover. Without `axes` a chart draws as before. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { Columns } from "./Charts";

const props = {
  labels: ["2026-09", "2026-10"], series: [{ name: "Sales", color: "#16695f" }, { name: "Gross profit", color: "#8fb3ae" }],
  values: [[1_900_000, 2_500_000], [1_000_000, 1_400_000]], format: (n: number | null | undefined) => `RM ${n ?? 0}`,
  stacked: false, highlight: null, height: 240, valueLabels: false, forecast: null,
  line: { name: "Net profit %", color: "#a16a2e", values: [12.5, 9.5], format: (x: number) => `${x.toFixed(1)}%` },
};

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} disconnect() {} };
});

describe("Columns with axes", () => {
  it("prints the money scale and the % scale", () => {
    const { container } = render(<Columns {...props} axes />);
    const ticks = [...container.querySelectorAll("text")].map((t) => t.textContent);
    expect(ticks).toContain("2.5M");
    expect(ticks.some((t) => /^\d+%$/.test(t))).toBe(true);
  });

  it("shows every figure of the column under the pointer", () => {
    const { container } = render(<Columns {...props} axes />);
    const bands = container.querySelectorAll("rect[fill='transparent']");
    fireEvent.mouseEnter(bands[1]!);
    expect(screen.getByText("RM 2500000")).toBeTruthy();
    expect(screen.getByText("RM 1400000")).toBeTruthy();
    expect(screen.getByText("9.5%")).toBeTruthy();
  });

  it("without axes there are no scale labels", () => {
    const { container } = render(<Columns {...props} axes={false} />);
    expect([...container.querySelectorAll("text")].map((t) => t.textContent)).not.toContain("2.5M");
  });
});

describe("Columns - forecast drawn apart from actual (owner 2026-11-19)", () => {
  it("hatches the forecast share of a column, dashes the line into it, and says so", () => {
    const { container } = render(<Columns {...props} axes forecast={{ share: [0, 0.5] }} />);
    expect(container.querySelectorAll("svg[aria-label='Column chart'] rect[stroke-dasharray]")).toHaveLength(2);
    expect([...container.querySelectorAll("polyline")].some((l) => l.getAttribute("stroke-dasharray"))).toBe(true);
    expect(screen.getByText(/Forecast \(hatched bar, dashed line\)/)).toBeTruthy();
    fireEvent.mouseEnter(container.querySelectorAll("rect[fill='transparent']")[1]!);
    expect(screen.getByText("50% of sales is forecast")).toBeTruthy();
  });

  it("an all-actual chart has no hatching and no forecast note", () => {
    const { container } = render(<Columns {...props} axes forecast={{ share: [0, 0] }} />);
    expect(container.querySelectorAll("rect[stroke-dasharray]")).toHaveLength(0);
    expect(screen.queryByText(/Forecast \(hatched bar/)).toBeNull();
  });
});
