import { describe, expect, it } from "vitest";
import type { PeriodTotals } from "./LogisticPeriodSection";
import { focusPeriod, jobDate, lorryOtherJobs, reportWindows, windowsInRange } from "./logisticFocus";
import type { LorryJobDetail, LorryJobKind } from "../../vendor/shared/logistic-region";

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
  lorryJobs: [{ plate: "B", date: "2026-11-02", kind: "setup" }],
  categoryByRegion: { Northern: { byCategory: [{ category: "Sofa", orders: 2, amountSen: 400, avgSen: 200 }], chargesSen: 5 } },
} as unknown as PeriodTotals;

describe("the jobs under a lorry", () => {
  const job = (kind: LorryJobKind, date: string, doId: string | null): LorryJobDetail => ({ plate: "A", date, kind, type: kind, ref: null, customer: null, assrId: null, doId });
  const jobs = [job("transport", "2026-11-05", null), job("service", "2026-11-05", null), job("setup", "2026-11-06", null), job("delivery", "2026-11-05", "do1"), job("delivery", "2026-11-05", "do2")];
  it("lists every counted job, a run's stock move and service case included", () => {
    expect(lorryOtherJobs(jobs, "A", "2026-11-01", "2026-11-07", null, new Set(["do1", "do2"])).map((j) => j.kind)).toEqual(["transport", "service", "setup"]);
  });
  it("keeps a delivery stop whose order is not on the list, so a counted day is never blank", () => {
    expect(lorryOtherJobs(jobs, "A", "2026-11-01", "2026-11-07", null, new Set(["do1"])).map((j) => j.doId)).toContain("do2");
  });
  it("follows the same region and date rule as the row's figures", () => {
    expect(lorryOtherJobs(jobs, "A", "2026-11-06", "2026-11-06", "Northern", new Set()).map((j) => j.kind)).toEqual(["setup"]);
    expect(lorryOtherJobs(jobs, "A", "2026-11-05", "2026-11-05", "Northern", new Set()).map((j) => j.kind)).toEqual(["transport"]);
    expect(lorryOtherJobs(jobs, "B", "2026-11-01", "2026-11-07", null, new Set())).toEqual([]);
  });
});

describe("one region of the logistic overview", () => {
  it("leaves the page alone when no region is picked", () => {
    expect(focusPeriod(period, null, null)).toBe(period);
  });

  it("recomputes the totals, the days and the category from that region", () => {
    const f = focusPeriod(period, "Northern", null);
    expect([f.doCount, f.doAmountSen, f.podClosed]).toEqual([2, 400, 1]);
    expect(f.days[0]).toMatchObject({ orders: 1, amountSen: 100, lorries: 1 });
    expect(f.byCategory[0]?.amountSen).toBe(400);
    expect(f.chargesSen).toBe(5);
  });

  it("lists only the lorries that carried there, per delivery day from that region", () => {
    const f = focusPeriod(period, "Northern", null);
    expect(f.byLorry.map((l) => [l.lorry, l.daysOut, l.perDayOutSen])).toEqual([["A", 2, 200]]);
  });

  it("keeps a lorry's set-ups, whichever region it delivered to", () => {
    expect(focusPeriod(period, "Southern", null).byLorry[0]).toMatchObject({ lorry: "B", fairTrips: 1, trips: 2, workingDays: 2 });
  });

  it("a picked day shows that day's lorries, and their orders add up to the day", () => {
    const f = focusPeriod(period, null, "2026-11-01");
    expect(f.byLorry.map((l) => [l.lorry, l.doOrders])).toEqual([["A", 1], ["B", 1]]);
    expect(f.byLorry.reduce((a, l) => a + l.doOrders, 0)).toBe(f.doCount);
    expect(f.days).toHaveLength(2);
  });
});

describe("the date a job falls on", () => {
  it("is the delivery date, the latest one set", () => {
    expect(jobDate({ effective_delivery_date: "2026-11-09", sales_exemption_expiry: "2026-11-01" })).toBe("2026-11-09");
  });
  it("falls back to the sales exemption date", () => {
    expect(jobDate({ effective_delivery_date: null, sales_exemption_expiry: "2026-11-01" })).toBe("2026-11-01");
    expect(jobDate({ effective_delivery_date: null, ac_sales_exemption_expiry: "2026-11-02" })).toBe("2026-11-02");
  });
  it("has no date when neither is set", () => {
    expect(jobDate({ effective_delivery_date: null })).toBeNull();
  });
});

describe("reports follow the picked dates", () => {
  it("cuts the weeks to the range", () => {
    expect(windowsInRange("2026-11-05", "2026-11-10", "week").map((w) => [w.label, w.from, w.to])).toEqual([["W1", "2026-11-05", "2026-11-07"], ["W2", "2026-11-08", "2026-11-10"]]);
  });
  it("a month view of a part month stops at the range", () => {
    expect(windowsInRange("2026-11-05", "2026-11-10", "month")).toEqual([{ key: "2026-11-01", label: "2026-11", from: "2026-11-05", to: "2026-11-10" }]);
  });
  it("runs across a year end", () => {
    expect(windowsInRange("2026-12-20", "2027-01-05", "month").map((w) => w.label)).toEqual(["2026-12", "2027-01"]);
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
  it("gives one window a month for the monthly report", () => {
    expect(reportWindows(["2026-02"], "month")).toEqual([{ key: "2026-02-01", label: "2026-02", from: "2026-02-01", to: "2026-02-28" }]);
  });
  it("drops a fifth week February does not have", () => {
    expect(reportWindows(["2026-02"], "week")).toHaveLength(4);
  });
});
