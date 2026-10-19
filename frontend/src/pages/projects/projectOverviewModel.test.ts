import { describe, expect, it } from "vitest";
import { figuresOf, totalsOf, trendOf, groupBy, drillOf, type OvProject } from "./projectOverviewModel";

const NO_SPLIT = { mattSofa: 0, bedframe: 0, accessories: 0 };

const p = (o: Partial<OvProject>): OvProject => ({
  id: 1, code: "P1", name: "Fair", brand: "AKEMI", organizer: "MLE", venue: "MV", state: "KL", stage: "draft",
  startDate: "2026-10-02", endDate: "2026-10-04", eventType: "Exhibition",
  keyed: { income: 0, cogs: 0, rental: 0, commission: 0, setup: 0, transport: 0, merchandise: 0, other: 0, cogsMattSofa: 0, cogsBedframe: 0, cogsAccessories: 0, transportFee: 0, transportSetup: 0 },
  salesOrders: { sen: 0, costSen: 0, count: 0, costSplit: NO_SPLIT }, ...o,
});

describe("Project Overview figures", () => {
  it("uses the keyed books when they exist", () => {
    const f = figuresOf(p({ keyed: { income: 10000, cogs: 4000, rental: 2000, commission: 500, setup: 0, transport: 0, merchandise: 0, other: 0, cogsMattSofa: 0, cogsBedframe: 0, cogsAccessories: 0, transportFee: 0, transportSetup: 0 }, salesOrders: { sen: 999_00, costSen: 1_00, count: 1, costSplit: NO_SPLIT } }));
    expect(f).toMatchObject({ salesSource: "keyed", sales: 10000, cogs: 4000, gp: 6000, np: 3500, cogsFromSalesOrders: false });
  });

  it("falls back to the Sales Orders — amount for sales, cost for COGS — until the event is settled", () => {
    const f = figuresOf(p({ keyed: { income: 0, cogs: 0, rental: 2000, commission: 0, setup: 0, transport: 0, merchandise: 0, other: 0, cogsMattSofa: 0, cogsBedframe: 0, cogsAccessories: 0, transportFee: 0, transportSetup: 0 }, salesOrders: { sen: 8000_00, costSen: 3000_00, count: 3, costSplit: NO_SPLIT } }));
    expect(f).toMatchObject({ salesSource: "sales_orders", sales: 8000, cogs: 3000, gp: 5000, np: 3000, cogsFromSalesOrders: true });
  });

  it("an event with neither shows its booked cost as a loss and says so", () => {
    const f = figuresOf(p({ keyed: { income: 0, cogs: 0, rental: 2000, commission: 0, setup: 0, transport: 0, merchandise: 0, other: 0, cogsMattSofa: 0, cogsBedframe: 0, cogsAccessories: 0, transportFee: 0, transportSetup: 0 } }));
    expect(f).toMatchObject({ salesSource: "none", sales: 0, np: -2000 });
    expect(totalsOf([p({}), p({ salesOrders: { sen: 100_00, costSen: 0, count: 1, costSplit: NO_SPLIT } })])).toMatchObject({ projects: 2, noSales: 1, fromSalesOrders: 1, sales: 100 });
  });

  it("trend buckets by event start; groups largest sales first", () => {
    const ps = [p({ id: 1, startDate: "2026-09-10", salesOrders: { sen: 500_00, costSen: 0, count: 1, costSplit: NO_SPLIT } }), p({ id: 2, startDate: "2026-10-01", brand: "ZANOTTI", salesOrders: { sen: 900_00, costSen: 0, count: 1, costSplit: NO_SPLIT } })];
    const t = trendOf(ps, "2026-10-17", "month");
    expect(t).toHaveLength(12);
    expect(t.at(-1)).toMatchObject({ key: "2026-10", sales: 900 });
    expect(t.at(-2)).toMatchObject({ key: "2026-09", sales: 500 });
    expect(trendOf(ps, "2026-10-17", "quarter").at(-1)).toMatchObject({ key: "2026-Q4", sales: 900 });
    expect(groupBy(ps, (x) => x.brand).map((g) => g.key)).toEqual(["ZANOTTI", "AKEMI"]);
  });
  it("drills year, quarter, month, week by event start", () => {
    const ps = [p({ id: 1, startDate: "2025-03-10", salesOrders: { sen: 100_00, costSen: 0, count: 1, costSplit: NO_SPLIT } }), p({ id: 2, startDate: "2026-10-09", salesOrders: { sen: 900_00, costSen: 0, count: 1, costSplit: NO_SPLIT } }), p({ id: 3, startDate: "2026-10-30", salesOrders: { sen: 50_00, costSen: 0, count: 1, costSplit: NO_SPLIT } })];
    expect(drillOf(ps, { level: "years" }, "2026-10-17").map((b) => [b.key, b.sales])).toEqual([["2025", 100], ["2026", 950]]);
    expect(drillOf(ps, { level: "quarters", year: 2026 }, "2026-10-17").map((b) => b.sales)).toEqual([0, 0, 0, 950]);
    expect(drillOf(ps, { level: "months", year: 2026, quarter: 4 }, "2026-10-17")[0]).toMatchObject({ key: "2026-10", sales: 950, next: { level: "weeks", month: "2026-10" } });
    const yr = drillOf(ps, { level: "yearMonths", year: 2026 }, "2026-10-17");
    expect(yr).toHaveLength(12);
    expect(yr[9]).toMatchObject({ key: "2026-10", sales: 950 });
    expect(drillOf(ps, { level: "weeks", month: "2026-10" }, "2026-10-17").map((b) => [b.label, b.sales])).toEqual([["10/01–10/07", 0], ["10/08–10/14", 900], ["10/15–10/21", 0], ["10/22–10/31", 50]]);
  });

  it("an event with no COGS keyed splits its Sales Orders' cost by product group; what no line accounts for stays apart", () => {
    const t = totalsOf([p({ salesOrders: { sen: 1000_00, costSen: 400_00, count: 2, costSplit: { mattSofa: 250_00, bedframe: 100_00, accessories: 40_00 } } })]);
    expect(t).toMatchObject({ cogs: 400, cogsMattSofa: 250, cogsBedframe: 100, cogsAccessories: 40, cogsFromSo: 10 });
  });
});
