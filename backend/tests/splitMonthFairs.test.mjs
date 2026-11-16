/* The fairs of 27 July – 2 August 2026 that FAIR PNL Y'2026 splits into a July row and an
   August row (2026-11-16): the system held their COGS, rental and setup for the whole fair but
   their Sales only for July — Selangor [AKEMI] MYHOME @ SUNWAY PYRAMID read RM 47,854 of sales
   against RM 130,564 of COGS. Only a fair still exactly in that shape gets its August part. */
import { describe, expect, it } from "vitest";
import { SPLIT_FAIRS, planSplitFairs } from "../scripts/lib/split-month-fairs.mjs";

const now = (over = {}) => SPLIT_FAIRS.map((f) => ({
  projectId: f.projectId, companyId: 1, name: `X [${f.brand}] Y @ ${f.venue} Z`, brand: f.brand, endDate: "2026-08-02",
  typedSales: f.julySales, bills: 0, augustLines: 0, commissionLines: f.julySales > 0 ? [{ id: f.projectId * 10, amount: f.julySales * 0.14 }] : [],
  ...(over[f.projectId] ?? {}),
}));

describe("the August part of the split fairs", () => {
  it("each fair still in the July-only shape gets its August Sales, and its typed commission lines go", () => {
    const { add, left } = planSplitFairs(now(), 1);
    expect(left).toEqual([]);
    expect(add.map((a) => [a.projectId, a.augustSales, a.archiveCommission])).toEqual([
      [469, 47864, [4690]], [2217, 7300, []], [391, 37594, [3910]], [2216, 21130, []],
      [232, 242887, [2320]], [233, 49494, [2330]], [397, 10888, [3970]],
    ]);
    expect(add.reduce((s, a) => s + a.augustSales, 0)).toBe(417157);
  });

  it("a fair in any other shape is left alone, with why", () => {
    const { add, left } = planSplitFairs(now({
      469: { augustLines: 1 },
      2217: { companyId: 2 },
      391: { typedSales: 78770 },
      2216: { bills: 3 },
      232: { endDate: "2026-08-03" },
      233: { brand: "AKEMI" },
      397: { name: "Selangor [ERGOTEX] MYHOME @ MITEC" },
    }), 1);
    expect(add).toEqual([]);
    expect(left).toEqual([
      { projectId: 469, why: "its August part is already in" },
      { projectId: 2217, why: "another company's" },
      { projectId: 391, why: "its sales are not the July part the file shows" },
      { projectId: 2216, why: "it has bills keyed" },
      { projectId: 232, why: "it does not end on 2026-08-02" },
      { projectId: 233, why: "the brand is not ZANOTTI" },
      { projectId: 397, why: "the name does not say SUNWAY PYRAMID" },
    ]);
  });

  it("a fair missing from the read is left alone", () => {
    expect(planSplitFairs(now().filter((f) => f.projectId !== 233), 1).left).toEqual([{ projectId: 233, why: "not found" }]);
  });
});
