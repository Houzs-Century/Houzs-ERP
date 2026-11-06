import { describe, expect, it } from "vitest";
import type { PeriodTotals } from "./LogisticPeriodSection";
import { focusPeriod, reportWindows } from "./logisticFocus";

const period = {
  from: "2026-11-01", to: "2026-11-02", doCount: 3, doAmountSen: 600, podClosed: 1,
  days: [
    { date: "2026-11-01", orders: 2, amountSen: 300, avgOrderSen: 150, lorries: 1, lorryOrders: 2, perLorrySen: 300 },
    { date: "2026-11-02", orders: 1, amountSen: 300, avgOrderSen: 300, lorries: 1, lorryOrders: 1, perLorrySen: 300 },
  ],
  byRegion: [],
  lorry: { lorryDays: 2, recordedOrders: 3, perLorrySen: 300, workingDays: 2 },
  byLorry: [
    { lorry: "A", internal: true, daysOut: 2, usedDays: 2, workingDays: 2, downDays: 0, occupancyPct: 100, orders: 2, amountSen: 400, perDayOutSen: 200 },
    { lorry: "B", internal: true, daysOut: 1, usedDays: 1, workingDays: 2, downDays: 0, occupancyPct: 50, orders: 1, amountSen: 200, perDayOutSen: 200 },
  ],
  lorryDayList: [],
  doList: [
    { id: "1", doNumber: null, soDocNo: null, customer: null, date: "2026-11-01", region: "Northern", state: null, amountSen: 100, lorry: "A", status: "DELIVERED" },
    { id: "2", doNumber: null, soDocNo: null, customer: null, date: "2026-11-01", region: "Southern", state: null, amountSen: 200, lorry: "B", status: "LOADED" },
    { id: "3", doNumber: null, soDocNo: null, customer: null, date: "2026-11-02", region: "Northern", state: null, amountSen: 300, lorry: "A", status: "LOADED" },
  ],
  byCategory: [{ category: "Sofa", orders: 3, amountSen: 600, avgSen: 200 }],
  chargesSen: 0,
  categoryByRegion: { Northern: { byCategory: [{ category: "Sofa", orders: 2, amountSen: 400, avgSen: 200 }], chargesSen: 5 } },
} as unknown as PeriodTotals;

describe("one region of the logistic overview", () => {
  it("leaves the page alone when no region is picked", () => {
    expect(focusPeriod(period, null)).toBe(period);
  });

  it("recomputes the totals, the days and the category from that region", () => {
    const f = focusPeriod(period, "Northern");
    expect([f.doCount, f.doAmountSen, f.podClosed]).toEqual([2, 400, 1]);
    expect(f.days[0]).toMatchObject({ orders: 1, amountSen: 100, lorries: 1 });
    expect(f.byCategory[0]?.amountSen).toBe(400);
    expect(f.chargesSen).toBe(5);
  });

  it("lists only the lorries that carried there, per delivery day from that region", () => {
    const f = focusPeriod(period, "Northern");
    expect(f.byLorry.map((l) => [l.lorry, l.daysOut, l.perDayOutSen])).toEqual([["A", 2, 200]]);
  });

  it("keeps a lorry's own days in use, whichever region it went to", () => {
    expect(focusPeriod(period, "Southern").byLorry[0]).toMatchObject({ lorry: "B", usedDays: 1, workingDays: 2 });
  });
});

describe("report windows", () => {
  it("cuts a month into five weeks", () => {
    expect(reportWindows(["2026-11"], "week").map((w) => [w.label, w.from, w.to])).toEqual([
      ["W1", "2026-11-01", "2026-11-07"], ["W2", "2026-11-08", "2026-11-14"], ["W3", "2026-11-15", "2026-11-21"],
      ["W4", "2026-11-22", "2026-11-28"], ["W5", "2026-11-29", "2026-11-30"],
    ]);
  });
  it("cuts a month in two for the bi-weekly report", () => {
    expect(reportWindows(["2026-11"], "fortnight").map((w) => [w.label, w.to])).toEqual([["B1", "2026-11-14"], ["B2", "2026-11-30"]]);
  });
  it("drops a fifth week February does not have", () => {
    expect(reportWindows(["2026-02"], "week")).toHaveLength(4);
  });
});
