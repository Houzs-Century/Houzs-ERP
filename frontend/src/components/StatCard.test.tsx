// A stat tile summarises a row set. When that row set is empty because it has
// not LOADED — a first paint, a search in flight, a failed fetch — every
// aggregate over it is 0, and a card that prints "RM 0.00" is stating a fact it
// does not have. This suite pins the unknown state so the placeholder can never
// quietly regress back into a confident number.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatCard } from "./StatCard";

afterEach(cleanup);

describe("StatCard pending state", () => {
  it("renders the value when it is known", () => {
    render(<StatCard label="Inventory Value" value="RM 12,400.00" />);
    expect(screen.getByText("RM 12,400.00")).toBeTruthy();
  });

  it("never renders a money figure it cannot vouch for", () => {
    render(<StatCard label="Inventory Value" value="RM 0.00" pending />);
    expect(screen.queryByText("RM 0.00")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("marks the unknown value as busy for assistive tech", () => {
    const { container } = render(
      <StatCard label="Total COGS" value="RM 0.00" pending />,
    );
    expect(container.querySelector('[data-pending="true"]')).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("does not colour an unknown value as if it were a real result", () => {
    // tone="error" paints the number red. A red RM 0.00 that only means
    // "not loaded" reads as a settled, alarming answer.
    const { container } = render(
      <StatCard label="Outstanding (RM)" value="RM 0.00" tone="error" pending />,
    );
    const figure = container.querySelector('[data-pending="true"]');
    expect(figure?.className).toContain("text-ink-muted");
    expect(figure?.className).not.toContain("text-err");
  });

  it("replaces a subtitle that would describe the unloaded row set", () => {
    render(
      <StatCard label="Total COGS" value="RM 0.00" subtitle="0 consumptions" pending />,
    );
    expect(screen.queryByText("0 consumptions")).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});
