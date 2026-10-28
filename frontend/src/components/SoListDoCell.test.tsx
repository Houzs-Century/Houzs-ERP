import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SoListDoCell, DO_CELL_MAX } from "./SoListDoCell";

afterEach(cleanup);

describe("SoListDoCell (SO list DO No. column)", () => {
  it("shows a dash when the order has no delivery order", () => {
    // The column it replaced fell back to the SO's own number here, which read
    // as a delivery that had not happened. A dash is the honest answer.
    const { container } = render(<SoListDoCell doNos={[]} />);
    expect(container.textContent).toBe("—");
    render(<SoListDoCell doNos={null} />);
    render(<SoListDoCell />);
  });

  it("renders every DO of a part-delivered order, in the order given", () => {
    render(<SoListDoCell doNos={["2990-DO-2608-004", "2990-DO-2607-001"]} />);
    const chips = screen.getAllByTitle(/^Delivery Order /);
    expect(chips.map((c) => c.textContent)).toEqual([
      "2990-DO-2608-004",
      "2990-DO-2607-001",
    ]);
  });

  it("caps the cell and names every hidden DO on the overflow chip", () => {
    const nos = ["DO-1", "DO-2", "DO-3", "DO-4", "DO-5"];
    render(<SoListDoCell doNos={nos} />);
    expect(screen.getAllByTitle(/^Delivery Order /)).toHaveLength(DO_CELL_MAX);
    // The "+N" is not allowed to be the end of the story — a second shipment
    // hidden behind a bare "+1" is exactly how one goes unnoticed.
    const overflow = screen.getByText(`+${nos.length - DO_CELL_MAX}`);
    expect(overflow.getAttribute("title")).toContain(nos.join(", "));
  });

  it("ignores empty entries rather than rendering a blank chip", () => {
    const { container } = render(<SoListDoCell doNos={["", "DO-REAL"]} />);
    expect(screen.getAllByTitle(/^Delivery Order /)).toHaveLength(1);
    expect(container.textContent).toContain("DO-REAL");
  });
});
