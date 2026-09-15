/* The ONE way a line column looks on a one-row-per-document grid (owner
 * 2026-09-15): the value, or the first value and "+N", every value in the
 * tooltip; sums for quantities; each line's own cell in the export. */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  LineValuesCell,
  compactLineValues,
  distinctLineValues,
  lineSumColumn,
  lineTextColumn,
} from "./dataTableLineCells";

type Line = { code: string | null; qty: number | null; sen: number | null };
type Doc = { lines: Line[] };

const doc: Doc = {
  lines: [
    { code: "A-1", qty: 2, sen: 1050 },
    { code: "B-2", qty: 1, sen: null },
    { code: "A-1", qty: 3, sen: 5.5 },
    { code: null, qty: null, sen: 100 },
  ],
};

afterEach(cleanup);

describe("compact values", () => {
  it("keeps distinct, non-blank values in line order", () => {
    expect(distinctLineValues(["A-1", "", null, "B-2", "A-1", "  ", 3, undefined])).toEqual(["A-1", "B-2", "3"]);
    expect(compactLineValues(["A-1", "B-2", "A-1"])).toEqual({ first: "A-1", more: 1, all: ["A-1", "B-2"] });
    expect(compactLineValues([])).toEqual({ first: null, more: 0, all: [] });
  });

  it("renders one value alone, several as first +N with all in the tooltip, none as a dash", () => {
    const { rerender, container } = render(<LineValuesCell values={["A-1", "A-1"]} />);
    expect(screen.getByText("A-1").textContent).toBe("A-1");
    rerender(<LineValuesCell values={["A-1", "B-2", "C-3"]} />);
    const cell = container.querySelector("span[title]")!;
    expect(cell.getAttribute("title")).toBe("A-1\nB-2\nC-3");
    expect(cell.textContent).toBe("A-1 +2");
    rerender(<LineValuesCell values={[null, ""]} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("lineTextColumn", () => {
  const col = lineTextColumn<Doc, Line>({ key: "code", label: "Item Code", linesOf: (d) => d.lines, pick: (l) => l.code });

  it("funnels over every line's value, sorts by the first, and exports each line's own cell", () => {
    expect(col.getFilterValues!(doc)).toEqual(["A-1", "B-2"]);
    expect(col.getValue!(doc)).toBe("A-1");
    expect(doc.lines.map((l) => col.lineValue!(doc, l))).toEqual(["A-1", "B-2", "A-1", null]);
    expect(col.exportFormat).toBe("text");
    expect(col.disableSort).toBe(true);
  });

  it("a date column declares the date export format", () => {
    expect(lineTextColumn<Doc, Line>({ key: "d", label: "D", linesOf: (d) => d.lines, pick: () => null, exportFormat: "date" }).exportFormat).toBe("date");
  });
});

describe("lineSumColumn", () => {
  it("shows the sum on screen and converts each line's value for the file", () => {
    const qty = lineSumColumn<Doc, Line>({ key: "qty", label: "Qty", linesOf: (d) => d.lines, pick: (l) => l.qty, exportFormat: "number" });
    expect(qty.getValue!(doc)).toBe(6);
    expect(doc.lines.map((l) => qty.lineValue!(doc, l))).toEqual([2, 1, 3, null]);

    const total = lineSumColumn<Doc, Line>({
      key: "total", label: "Line Total", linesOf: (d) => d.lines, pick: (l) => l.sen, exportFormat: "money",
      toExport: (sen) => Number((sen / 100).toFixed(2)),
    });
    expect(total.getValue!(doc)).toBe(1155.5);
    expect(doc.lines.map((l) => total.lineValue!(doc, l))).toEqual([10.5, null, 0.06, 1]);
    expect(total.exportFormat).toBe("money");
    render(<>{total.render({ lines: [] })}</>);
    expect(screen.getByText("—")).toBeTruthy();
  });
});
