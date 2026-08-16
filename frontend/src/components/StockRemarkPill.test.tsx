// One value, one look. Until 2026-08-17 `stock_remark` was rendered three ways:
// a designed amber/mint pill on ConsignmentOrders, grey body text on the SO list
// (the column the owner actually has open), and a third pair of hard-coded hexes
// on the delivery-planning board. So a short order read as an incidental grey
// note on the one screen he has open.
//
// The vocabulary here is #2334's — the label names what IS ready. These pin the
// two things the cell has to do (be visibly not-ready, and order by how much is
// in) plus the negative branch #2334 added on purpose: anything that is not
// exactly READY takes the warning colours, so a NEW token can never fall through
// into a neutral slot and read as fine.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  StockRemarkPill,
  stockRemarkSortScore,
  stockRemarkSortFn,
  stockRemarkSearchValue,
  stockRemarkExportValue,
} from "./StockRemarkPill";

afterEach(cleanup);

describe("StockRemarkPill", () => {
  it("renders the remark verbatim — the label is the server's ruling, not the cell's", () => {
    render(<StockRemarkPill remark="MATTRESS/ACC" />);
    expect(screen.getByText("MATTRESS/ACC")).toBeTruthy();
  });

  it("paints a not-fully-ready remark in the warning slot, not as body text", () => {
    const { container } = render(<StockRemarkPill remark="PARTIAL" />);
    const pill = container.querySelector("span") as HTMLElement;
    // The amber WARNING pair from ConsignmentOrders, the design of record.
    expect(pill.style.background).toContain("232, 107, 58");
    expect(pill.style.fontWeight).toBe("700");
  });

  it("paints READY green, and the two states are visibly different", () => {
    const partial = render(<StockRemarkPill remark="PARTIAL" />).container.querySelector("span") as HTMLElement;
    const ready = render(<StockRemarkPill remark="READY" />).container.querySelectorAll("span")[0] as HTMLElement;
    expect(ready.style.background).not.toBe(partial.style.background);
    expect(ready.style.color).not.toBe(partial.style.color);
  });

  it("an UNKNOWN token takes the warning colours, never a neutral slot (#2334)", () => {
    /* The branch is `=== 'READY'` and everything else is the warning pair. A
       vocabulary that grows a fourth token must not be able to render as fine. */
    const { container } = render(<StockRemarkPill remark="SOMETHING NEW" />);
    const pill = container.querySelector("span") as HTMLElement;
    expect(pill.style.background).toContain("232, 107, 58");
  });

  it("an empty remark is an em dash, never an empty cell", () => {
    render(<StockRemarkPill remark="" />);
    expect(screen.getByText("—")).toBeTruthy();
    cleanup();
    render(<StockRemarkPill remark={null} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("stock remark ordering", () => {
  it("READY outranks PARTIAL outranks a ready-list outranks blank", () => {
    expect(stockRemarkSortScore("READY")).toBeGreaterThan(stockRemarkSortScore("PARTIAL"));
    expect(stockRemarkSortScore("PARTIAL")).toBeGreaterThan(stockRemarkSortScore("BEDFRAME"));
    expect(stockRemarkSortScore("BEDFRAME")).toBeGreaterThan(stockRemarkSortScore(""));
  });

  it("a LONGER ready list means more is in, so it sorts higher (#2334's direction)", () => {
    /* This is the inverse of the 2026-08-16-morning ordering, which scored a
       what-is-MISSING label. Getting the direction wrong here silently ranks the
       emptiest orders at the top of a column headed "Stock Status". */
    expect(stockRemarkSortScore("BEDFRAME/ACC")).toBeGreaterThan(stockRemarkSortScore("ACC"));
  });

  it("the comparator is what stops alphabetical order leading with the emptiest orders", () => {
    const rows = ["ACC", "READY", "", "BEDFRAME/ACC", "PARTIAL"];
    expect([...rows].sort(stockRemarkSortFn))
      .toEqual(["READY", "PARTIAL", "BEDFRAME/ACC", "ACC", ""]);
  });
});

describe("search and export accessors", () => {
  it("search is lowercased, export keeps the real words", () => {
    expect(stockRemarkSearchValue("BEDFRAME/ACC")).toBe("bedframe/acc");
    expect(stockRemarkExportValue(" BEDFRAME/ACC ")).toBe("BEDFRAME/ACC");
  });

  it("a missing remark exports as empty, never as the string 'null'", () => {
    expect(stockRemarkExportValue(null)).toBe("");
    expect(stockRemarkExportValue(undefined)).toBe("");
  });
});
