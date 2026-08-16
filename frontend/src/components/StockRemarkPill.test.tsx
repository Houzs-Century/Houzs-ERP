// One value, one look. Until 2026-08-17 `stock_remark` was rendered three ways:
// a designed amber/mint pill on ConsignmentOrders, grey body text on the SO list
// (the column the owner actually has open), and a third pair of hard-coded hexes
// on the delivery-planning board. So the system told him a mattress was SHORT
// and it looked like an incidental note.
//
// These pin the two things a warning has to do — be visibly a warning, and sort
// to the top — and the one thing it must not do, which is invent a vocabulary.
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
    render(<StockRemarkPill remark="SHORT: MATTRESS" />);
    expect(screen.getByText("SHORT: MATTRESS")).toBeTruthy();
  });

  it("paints SHORT in the warning slot, not as body text", () => {
    const { container } = render(<StockRemarkPill remark="SHORT: MATTRESS" />);
    const pill = container.querySelector("span") as HTMLElement;
    // The amber WARNING pair from ConsignmentOrders, the design of record.
    expect(pill.style.background).toContain("232, 107, 58");
    expect(pill.style.fontWeight).toBe("700");
  });

  it("paints READY green, and the two states are visibly different", () => {
    const short = render(<StockRemarkPill remark="SHORT: BEDFRAME" />).container.querySelector("span") as HTMLElement;
    const ready = render(<StockRemarkPill remark="READY" />).container.querySelectorAll("span")[0] as HTMLElement;
    expect(ready.style.background).not.toBe(short.style.background);
    expect(ready.style.color).not.toBe(short.style.color);
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
  it("READY outranks every SHORT, and SHORT outranks blank", () => {
    expect(stockRemarkSortScore("READY")).toBeGreaterThan(stockRemarkSortScore("SHORT: ACCESSORY"));
    expect(stockRemarkSortScore("SHORT: ACCESSORY")).toBeGreaterThan(stockRemarkSortScore(""));
  });

  it("one thing away sorts above waiting on everything", () => {
    expect(stockRemarkSortScore("SHORT: ACCESSORY"))
      .toBeGreaterThan(stockRemarkSortScore("SHORT: BEDFRAME, MATTRESS, ACCESSORY"));
  });

  it("the comparator is what stops alphabetical order ranking a cushion over a bed", () => {
    /* Alphabetically `SHORT: ACCESSORY` < `SHORT: BEDFRAME`, so a plain string
       sort would put the accessory-only order above the one missing its bed.
       The comparator ranks by how much is missing instead. */
    const rows = ["SHORT: BEDFRAME, MATTRESS", "READY", "", "SHORT: ACCESSORY"];
    expect([...rows].sort(stockRemarkSortFn))
      .toEqual(["READY", "SHORT: ACCESSORY", "SHORT: BEDFRAME, MATTRESS", ""]);
  });
});

describe("search and export accessors", () => {
  it("search is lowercased, export keeps the real words", () => {
    expect(stockRemarkSearchValue("SHORT: MATTRESS")).toBe("short: mattress");
    expect(stockRemarkExportValue(" SHORT: MATTRESS ")).toBe("SHORT: MATTRESS");
  });

  it("a missing remark exports as empty, never as the string 'null'", () => {
    expect(stockRemarkExportValue(null)).toBe("");
    expect(stockRemarkExportValue(undefined)).toBe("");
  });
});
