// @vitest-project light
/* Which typed sales line repeats a fair's bills (2026-11-16): project 70 read
   RM 501,070 on the Project Overview — its 31 bills (RM 250,535) plus the align
   pass's typed "sales" line of the same amount. Only that exact shape is archived. */
import { describe, expect, it } from "vitest";
import { ALIGN_DESCRIPTION, pickDuplicateSalesLines } from "../scripts/lib/duplicate-fair-sales.mjs";

const row = (over = {}) => ({
  lineId: 16296, projectId: 70, companyId: 1, projectCompanyId: 1,
  description: ALIGN_DESCRIPTION, amount: 250535, bills: 31, billsSum: 250535, typedSalesLines: 1, ...over,
});

describe("the duplicate typed sales line", () => {
  it("the align pass's line, the fair's only typed sales line, equal to its bills: archived", () => {
    const { archive, left } = pickDuplicateSalesLines([row()], 1);
    expect(archive.map((r) => r.lineId)).toEqual([16296]);
    expect(left).toEqual([]);
  });

  it("every other shape is left alone, with why", () => {
    const { archive, left } = pickDuplicateSalesLines([
      row({ lineId: 1, projectCompanyId: 2 }),
      row({ lineId: 2, companyId: 2 }),
      row({ lineId: 3, description: "Total sales typed by Finance" }),
      row({ lineId: 4, bills: 0, billsSum: 0 }),
      row({ lineId: 5, billsSum: 250534.99 }),
      row({ lineId: 6, typedSalesLines: 2 }),
    ], 1);
    expect(archive).toEqual([]);
    expect(left.map((r) => [r.lineId, r.why])).toEqual([
      [1, "the fair is another company's"],
      [2, "the line is stamped with another company"],
      [3, "not the align pass's line"],
      [4, "the fair has no bills"],
      [5, "its amount is not the bills' total"],
      [6, "the fair has more than one typed sales line"],
    ]);
  });

  it("a line with no company stamp follows its fair's company; amounts compare to the sen", () => {
    const { archive } = pickDuplicateSalesLines([row({ companyId: null, amount: 20840, billsSum: 20840.004 })], 1);
    expect(archive).toHaveLength(1);
  });
});
