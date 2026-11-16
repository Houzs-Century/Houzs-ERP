/* The owner's decisions after checking every 2026 fair against FAIR PNL Y'2026 (2026-11-16):
   #2006 was a second copy of #119 (AKEMI REX @ PAVILION BUKIT JALIL, February read its RM 77,598
   of sales twice), #2038 carried RM 21,490 of April sales nothing stood behind, four fairs across
   two months held one month's rental, and three fairs had the wrong dates or venue. Each fair is
   changed only while it is still exactly in that shape. */
import { describe, expect, it } from "vitest";
import {
  DUPLICATE, NO_SALES, RENTAL_PARTS, planDecisions, rentalPartDescription,
} from "../scripts/lib/fair-pnl-2026-decisions.mjs";

const line = (id, kind, category, amount, extra = {}) => ({ id, kind, category, description: null, amount, auto: false, ...extra });
const fair = (projectId, brand, venue, start, end, lines, extra = {}) => ({
  projectId, companyId: 1, brand, venue, start, end, status: "confirmed", bills: 0, orders: 0, rentalInBooks: 0, lines, ...extra,
});

/** The fairs as the check found them. */
const found = (over = {}) => {
  const rows = [
    fair(2006, "AKEMI", "PAVILION BUKIT JALIL", "2026-02-28", "2026-02-28", [
      line(1, "income", "sales", 77598), line(2, "cost", "rental", 16000), line(3, "cost", "setup", 3447),
      line(4, "cost", "merchandise", 1552, { auto: true }), line(5, "cost", "transport_fee", 3104, { auto: true }),
    ]),
    fair(119, "AKEMI", "PAVILION BUKIT JALIL", "2026-01-30", "2026-02-02", [
      line(10, "income", "sales", 77598), line(11, "cost", "cogs_matt_sofa", 25823), line(12, "cost", "rental", 16000),
    ]),
    fair(2254, "AKEMI", "PAVILION BUKIT JALIL", "2026-03-26", "2026-03-28", [line(20, "cost", "rental", 28215)]),
    fair(2038, "ZANOTTI", "STADIUM BUKIT JALIL", "2026-04-09", "2026-04-12", [line(30, "income", "sales", 21490), line(31, "cost", "setup", 3321)]),
    fair(107, "ERGOTEX", "PAVILION BUKIT JALIL", "2026-01-30", "2026-02-02", [line(40, "income", "sales", 52073), line(41, "cost", "rental", 12000)]),
    fair(123, "AKEMI", "MID VALLEY", "2026-02-27", "2026-03-01", [line(50, "income", "sales", 83538), line(51, "cost", "rental", 27200)]),
    fair(124, "ERGOTEX", "MID VALLEY", "2026-02-27", "2026-03-01", [line(60, "income", "sales", 83557), line(61, "cost", "rental", 22000)]),
    fair(105, "ZANOTTI", "MID VALLEY", "2026-02-27", "2026-03-01", [line(70, "income", "sales", 46046), line(71, "cost", "rental", 20000)]),
    fair(2005, "ZANOTTI", "IOIGECC", "2026-02-28", "2026-02-28", [line(80, "income", "sales", 2000)]),
    fair(2219, "ZANOTTI", "IOI MALL PUTRAJAYA", "2026-08-28", "2026-08-31", [line(90, "income", "sales", 36406)]),
  ];
  return rows.map((r) => ({ ...r, ...(over[r.projectId] ?? {}) }));
};

/** The same fairs once the decisions are in. */
const decided = () => found({
  2006: { status: "cancelled", lines: [] },
  119: { lines: [line(10, "income", "sales", 77598), line(11, "cost", "cogs_matt_sofa", 25823), line(12, "cost", "rental", 16000),
    line(13, "cost", "rental", 16000, { description: "Rental (February half, moved from duplicate #2006; FAIR PNL Y2026)" })] },
  2254: { start: "2026-03-06", end: "2026-03-08", lines: [line(20, "cost", "rental", 28215), line(21, "cost", "setup", 3447)] },
  2038: { lines: [line(31, "cost", "setup", 3321)] },
  ...Object.fromEntries(RENTAL_PARTS.map((r) => [r.projectId, {
    lines: [line(r.projectId * 10, "cost", "rental", r.has), line(r.projectId * 10 + 1, "cost", "rental", r.add, { description: rentalPartDescription(r.part) })],
  }])),
  2005: { start: "2026-01-30", end: "2026-02-02" },
  2219: { venue: "IOIGECC" },
});

describe("the owner's FAIR PNL 2026 decisions", () => {
  it("each fair still in the shape the check found gets its change", () => {
    const { steps, left } = planDecisions(found(), 1);
    expect(left).toEqual([]);
    expect(steps).toEqual([
      { kind: "duplicate", projectId: 2006, archive: [1, 2, 3, 4, 5] },
      { kind: "noSales", projectId: 2038, archive: [30] },
      { kind: "rental", projectId: 107, amount: 12000, description: "Rental (February part, FAIR PNL Y2026)" },
      { kind: "rental", projectId: 123, amount: 13600, description: "Rental (March part, FAIR PNL Y2026)" },
      { kind: "rental", projectId: 124, amount: 11000, description: "Rental (March part, FAIR PNL Y2026)" },
      { kind: "rental", projectId: 105, amount: 10000, description: "Rental (March part, FAIR PNL Y2026)" },
      { kind: "dates", projectId: 2254, from: { start: "2026-03-26", end: "2026-03-28" }, to: { start: "2026-03-06", end: "2026-03-08" } },
      { kind: "dates", projectId: 2005, from: { start: "2026-02-28", end: "2026-02-28" }, to: { start: "2026-01-30", end: "2026-02-02" } },
      { kind: "venue", projectId: 2219, from: "IOI MALL PUTRAJAYA", to: "IOIGECC" },
    ]);
    expect(RENTAL_PARTS.reduce((s, r) => s + r.add, 0)).toBe(46600);
    expect([DUPLICATE.sales, DUPLICATE.rental, DUPLICATE.setup, NO_SALES.sales]).toEqual([77598, 16000, 3447, 21490]);
  });

  it("run again, every fair is already done and nothing is changed", () => {
    const { steps, left } = planDecisions(decided(), 1);
    expect(steps).toEqual([]);
    expect(left.map((l) => [l.projectId, l.why])).toEqual([
      [2006, "already done"], [2038, "already done"], [107, "already done"], [123, "already done"],
      [124, "already done"], [105, "already done"], [2254, "already done"], [2005, "already done"], [2219, "already done"],
    ]);
  });

  it("#2006 is left alone unless #119 holds the very same sales", () => {
    const { steps, left } = planDecisions(found({ 119: { lines: [line(10, "income", "sales", 70000), line(12, "cost", "rental", 16000)] } }), 1);
    expect(steps.some((s) => s.kind === "duplicate")).toBe(false);
    expect(left).toContainEqual({ projectId: 2006, decision: "duplicate", why: "#119's sales are not the same, so it is not a duplicate" });
  });

  it("a fair with orders, bills, COGS, books or other figures than the check found is left alone, with why", () => {
    const { steps, left } = planDecisions(found({
      2006: { orders: 1 },
      2038: { lines: [line(30, "income", "sales", 21490), line(32, "cost", "cogs_matt_sofa", 9000)] },
      107: { rentalInBooks: 1 },
      123: { lines: [line(51, "cost", "rental", 40800)] },
      124: { companyId: 2 },
      105: { brand: "AKEMI" },
      2254: { start: "2026-03-27" },
      2219: { venue: "SOMEWHERE ELSE" },
    }), 1);
    expect(steps.map((s) => s.projectId)).toEqual([2005]);
    expect(left.map((l) => [l.projectId, l.why])).toEqual([
      [2006, "it has orders"],
      [2038, "it has COGS"],
      [107, "its rental is in the books"],
      [123, "its rental is not the first month's part"],
      [124, "another company's"],
      [105, "the brand is not ZANOTTI"],
      [2254, "its dates are not the ones to fix"],
      [2219, "its venue is not the one to fix"],
    ]);
  });

  it("a fair missing from the read is left alone", () => {
    const { left } = planDecisions(found().filter((f) => f.projectId !== 2038), 1);
    expect(left).toContainEqual({ projectId: 2038, decision: "no sales", why: "not found" });
  });
});
