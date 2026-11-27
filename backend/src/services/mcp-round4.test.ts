import { describe, expect, it } from "vitest";
import { redactMoney } from "./mcp-access";
import { resolvePeriod } from "./mcp-period";
import { runRound3Tool, type R3Ctx, type R3Read } from "./mcp-round3";
import { eventsInWindow, ROUND4_TOOLS } from "./mcp-round4";
import {
  dashboardFigures,
  posWindowTotals,
  reportMonths,
  summariseAwaitingReceipt,
  summariseCustomer,
  summariseInventory,
  summariseOutletPeriod,
  summariseServiceCases,
  summariseSla,
  summariseStock,
  summariseUninvoiced,
} from "./mcp-round4-shape";

const today = "2026-11-26";
const origin = "https://erp.example.test";
const ok = (value: unknown): R3Read => ({ ok: true, status: 200, value, removed: [], target: "" });
const denied: R3Read = { ok: false, status: 403, message: "Not available to your role", note: "no permission", target: "" };

type Route = (q: Record<string, unknown> | undefined) => R3Read;
function fakeCtx(routes: Partial<Record<string, Route>>, sight: { finance: boolean; productCost: boolean } | null = null) {
  const calls: { path: string; q: Record<string, unknown> | undefined }[] = [];
  const ctx: R3Ctx = {
    read: async (path, q) => {
      calls.push({ path, q });
      const h = routes[path];
      const r = h ? h(q) : ({ ok: false, status: 404, message: "not found", note: "", target: path } as R3Read);
      if (!r.ok || !sight) return r;
      return { ...r, value: redactMoney(r.value, sight).value };
    },
    origin,
    userId: 7,
    bucket: {} as R3Ctx["bucket"],
    now: Date.parse("2026-11-26T04:00:00Z"),
  };
  return { ctx, calls };
}
const body = (o: { result: { content: { text: string }[] } }) => JSON.parse(o.result.content[0].text) as Record<string, unknown>;

describe("period windows", () => {
  it("reads every period name with its two comparisons", () => {
    expect(resolvePeriod({}, today)).toMatchObject({ period: "month", from: "2026-11-01", to: today, prev: { from: "2026-10-01", to: "2026-10-26" }, lastMonth: { from: "2026-10-01", to: "2026-10-26" } });
    expect(resolvePeriod({ period: "today" }, today)).toMatchObject({ from: today, to: today, prev: { from: "2026-11-25", to: "2026-11-25" }, lastMonth: { from: "2026-10-26", to: "2026-10-26" } });
    expect(resolvePeriod({ period: "week" }, today)).toMatchObject({ from: "2026-11-23", to: today, prev: { from: "2026-11-16", to: "2026-11-19" } });
    expect(resolvePeriod({ period: "last_month" }, today)).toMatchObject({ from: "2026-10-01", to: "2026-10-31", prev: { from: "2026-09-01", to: "2026-09-30" } });
    expect(resolvePeriod({ period: "quarter" }, today)).toMatchObject({ from: "2026-10-01", to: today, prev: { from: "2026-07-01", to: "2026-08-26" } });
    expect(resolvePeriod({ period: "year" }, today)).toMatchObject({ from: "2026-01-01", prev: { from: "2025-01-01", to: "2025-11-26" } });
    expect(resolvePeriod({ period: "custom", from: "2026-11-10", to: "2026-11-19" }, today)).toMatchObject({ prev: { from: "2026-10-31", to: "2026-11-09" } });
    expect(resolvePeriod({ period: "2026-09" }, today)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("refuses an unreadable or future window", () => {
    expect(resolvePeriod({ period: "fortnight" }, today)).toBeNull();
    expect(resolvePeriod({ period: "custom", from: "2026-11-20", to: "2026-12-01" }, today)).toBeNull();
    expect(resolvePeriod({ period: "custom", from: "2026-11-20" }, today)).toBeNull();
  });

  it("company_report months: to date, a named month, and the period before", () => {
    expect(reportMonths("", today)).toEqual({ label: "2026-11 to date", months: ["2026-11"], prevMonths: ["2026-10"] });
    expect(reportMonths("quarter", today)).toMatchObject({ months: ["2026-10", "2026-11"], prevMonths: ["2026-07", "2026-08"] });
    expect(reportMonths("year", today)?.prevMonths[0]).toBe("2025-01");
    expect(reportMonths("year", today)?.months).toHaveLength(11);
    expect(reportMonths("last_month", today)).toMatchObject({ months: ["2026-10"], prevMonths: ["2026-09"] });
    expect(reportMonths("2025", today)?.months).toHaveLength(12);
    expect(reportMonths("2027-01", today)).toBeNull();
  });
});

describe("round-4 summaries", () => {
  it("stock_check: on hand by location type, reserved, incoming with ETA", () => {
    const s = summariseStock(
      { products: [{ item_code: "BF-1", product_name: "Bedframe", total_qty: 5, owned_qty: 4, held_qty: 1, committed_scheduled: 2, unscheduled_qty: 1, available_qty: 4, incoming_qty: 2, incoming_pos: [{ po_number: "PO-1", eta: "2026-12-01", qty: 2 }], stock_by_warehouse: [{ warehouse_id: "w1", code: "KL", name: "KL WH", qty: 3, held_qty: 0 }, { warehouse_id: "w2", code: "PJ", name: "PJ Showroom", qty: 2, held_qty: 1 }] }] },
      { warehouses: [{ id: "w1", type: "warehouse" }, { id: "w2", type: "showroom" }] },
      "BF",
      origin,
    );
    expect(s.items[0]).toMatchObject({ onHand: 5, consignmentHeld: 1, available: 4, inShowrooms: 2, incomingPos: [{ po: "PO-1", eta: "2026-12-01", qty: 2 }] });
    expect(s.items[0].byLocation.map((l) => l.type)).toEqual(["warehouse", "showroom"]);
    expect(summariseStock({ products: [] }, null, "zz", origin).answer).toBe('No product matches "zz".');
  });

  it("inventory_summary: short, negative and slow stock; value only when visible", () => {
    const products = { products: [{ item_code: "A", total_qty: 1, available_qty: -2, reserved_total: 3 }, { item_code: "B", total_qty: -1, movement_qty: -1 }, { item_code: "C", total_qty: 0 }] };
    const s = summariseInventory(products, { windowDays: 90, deadStock: [{ item_code: "D", qty: 2, lastSoldAt: null }] }, origin);
    expect(s.short.skus).toBe(1);
    expect(s.negative.top[0].item).toBe("B");
    expect(s.slowMoving).toMatchObject({ skus: 1, top: [{ item: "D", lastSold: "never" }] });
    expect(JSON.stringify(s.slowMoving)).not.toContain("valueRm");
  });

  it("uninvoiced_deliveries: totals plus by salesperson and customer", () => {
    const s = summariseUninvoiced({ as_of: today, rows: [{ do_number: "DO1", debtor_name: "Ali", salesperson: "Tan", unbilled_sen: 10000, age_days: 40 }, { do_number: "DO2", debtor_name: "Ali", salesperson: "Lim", unbilled_sen: 5000, age_days: 3 }], totals: { rows: 2, unbilled_sen: 15000, partly_invoiced: { rows: 1, unbilled_sen: 5000 }, over_365: { rows: 0, unbilled_sen: 0 } }, buckets: [] }, origin);
    expect(s.unbilledRm).toBe(150);
    expect(s.byCustomer[0]).toEqual({ name: "Ali", deliveryOrders: 2, unbilledRm: 150 });
    expect(s.bySalesperson[0].name).toBe("Tan");
    expect(s.partlyInvoiced).toEqual({ deliveryOrders: 1, unbilledRm: 50 });
  });

  it("po_awaiting_receipt: partly received vs none yet, by receiving location, value only with prices", () => {
    const rows = [
      { id: "1", po_number: "PO-1", status: "PARTIALLY_RECEIVED", expected_at: "2026-11-20", supplier: { name: "S1" }, lines: [{ qty: 4, received_qty: 1, remaining_qty: 3, location: "PJ SHOWROOM" }] },
      { id: "2", po_number: "PO-2", status: "SUBMITTED", expected_at: "2026-12-05", supplier: { name: "S2" }, lines: [{ qty: 2, received_qty: 0, remaining_qty: 2, unit_price_sen: 1000, location: "KL" }] },
      { id: "3", po_number: "PO-3", status: "SUBMITTED", on_hold: true, lines: [] },
    ];
    const s = summariseAwaitingReceipt(rows, today, origin, false);
    expect(s.stillBeingReceived).toEqual({ pos: 2, qtyRemaining: 5 });
    expect(s.partlyReceived.top[0]).toMatchObject({ po: "PO-1", daysLate: 6, qtyRemaining: 3 });
    expect(s.partlyReceived.top[0]).not.toHaveProperty("remainingValueRm");
    expect(s.awaitingFirstReceipt.top[0]).toMatchObject({ po: "PO-2", remainingValueRm: 20 });
    expect(s.byLocation[0]).toEqual({ location: "PJ SHOWROOM", pos: 1, qtyRemaining: 3 });
  });

  it("customer_overview: orders, open cases, last contact; no outstanding when the balance is hidden", () => {
    const s = summariseCustomer("0123", [{ doc_no: "SO1", debtor_name: "Ali", so_date: "2026-11-01", status: "CONFIRMED", balance_sen_live: 2500 }, { doc_no: "SO0", debtor_name: "Ali", so_date: "2026-10-01", status: "CANCELLED", balance_sen_live: 999 }], [{ id: 9, assr_no: "A9", stage: "qc", complaint_issue: "Leg broken", updated_at: "2026-11-20T03:00:00Z" }], [{ do_number: "DO1", do_date: "2026-11-10", status: "DELIVERED" }], origin, today);
    expect(s.outstanding).toEqual({ orders: 1, rm: 25 });
    expect(s.openServiceCases.cases[0]).toMatchObject({ case: "A9", about: "Leg broken" });
    expect(s.lastContact).toEqual({ kind: "service case", date: "2026-11-20", ref: "A9" });
    expect(s.lastDelivery?.delivered).toBe(true);
    const hidden = summariseCustomer("0123", [{ doc_no: "SO1", debtor_name: "Ali", status: "CONFIRMED" }], [], [], origin, today);
    expect(hidden).not.toHaveProperty("outstanding");
  });

  it("after_sales_sla: past deadline by stage and the most overdue", () => {
    const s = summariseSla({ breach_count: 2, aging_count: 1, by_stage: [{ stage: "qc", total: 5, breached: 2 }] }, { cases: [{ id: 1, assr_no: "A1", stage: "qc", priority: "high", deadline_at: "2026-11-20 10:00:00" }, { id: 2, assr_no: "A2", stage: "qc", deadline_at: "2026-11-25" }] }, { cases: [{ stage: "repair" }] }, today, origin);
    expect(s.pastDeadlineByStage).toEqual([{ stage: "qc", pastDeadline: 2, cases: 5 }]);
    expect(s.mostOverdue[0]).toMatchObject({ case: "A1", daysPastDeadline: 6 });
    expect(s.stuckInStage.byStage).toEqual([{ name: "repair", count: 1 }]);
  });

  it("service_cases: by category / outlet with what each case is about", () => {
    const p = resolvePeriod({ period: "month" }, today)!;
    const s = summariseServiceCases([{ id: 1, assr_no: "A1", issue_category: "Damage", location: "PJ", stage: "qc", complaint_issue: "x".repeat(300), complained_date: "2026-11-20" }], 1, 4, p, today, origin);
    expect(s).toMatchObject({ cases: 1, previousPeriodCases: 4, changePct: -75, stillOpen: 1 });
    expect(s.byOutlet[0]).toEqual({ name: "PJ", count: 1 });
    expect(s.recent[0].about?.length).toBe(160);
    expect(s.recent[0].ageDays).toBe(6);
  });

  it("outlet_sales: per outlet vs the previous period and the same days last month", () => {
    const p = resolvePeriod({ period: "month" }, today)!;
    const s = summariseOutletPeriod({ rows: [{ venue: "PJ", so_date: today, amount_sen: 20000 }, { venue: "KL", so_date: "2026-11-02", amount_sen: 10000 }] }, { rows: [{ venue: "PJ", amount_sen: 10000 }] }, { rows: [{ venue: "PJ", amount_sen: 10000 }] }, p, today, "https://erp.test");
    expect(s.totals).toMatchObject({ orders: 2, salesRm: 300, previousRm: 100, changePct: 200, sameDaysLastMonthRm: 100, todayOrders: 1, todayRm: 200 });
    expect(s.outlets[0]).toMatchObject({ outlet: "PJ", salesRm: 200, previousRm: 100, changePct: 100 });
    expect(s.outlets[0].url).toBe("https://erp.test/reports/fair-report?stage=so&from=2026-11-01&to=2026-11-26&venue=PJ");
  });

  it("outlet_sales merges outlet names typed in different case and shows the upper-case form", () => {
    const p = resolvePeriod({ period: "month" }, today)!;
    const cur = { rows: [{ venue: "PENANG WATERFRONT CONVENTION CENTRE", amount_sen: 10000 }, { venue: "Penang Waterfront Convention Centre", amount_sen: 5000 }, { venue: "  penang  waterfront convention centre ", amount_sen: 1000 }] };
    const s = summariseOutletPeriod(cur, { rows: [] }, null, p, today, "https://erp.test");
    expect(s.outlets).toHaveLength(1);
    expect(s.outlets[0]).toMatchObject({ outlet: "PENANG WATERFRONT CONVENTION CENTRE", orders: 3, salesRm: 160 });
    expect(s.outlets[0].spelledAs).toHaveLength(3);
    expect(s.outlets[0].url).not.toContain("venue=");
  });

  it("pos_sales: comparison days are cut from one report by day; events active in the window", () => {
    expect(posWindowTotals({ totals: { by_day: [{ day: "2026-10-05", bills: 2, net_sen: 500 }, { day: "2026-09-30", bills: 9, net_sen: 9 }] } }, { from: "2026-10-01", to: "2026-10-26" })).toEqual({ bills: 2, netSen: 500 });
    const evs = eventsInWindow({ data: [{ project_id: 1, name: "Old", status: "DONE", end_date: "2026-09-30" }, { project_id: 2, name: "Now", status: "ON GOING", start_date: "2026-11-20" }, { project_id: 3, name: "Oct", status: "DONE", start_date: "2026-10-01", end_date: "2026-10-10" }] }, { from: "2026-10-01", to: today });
    expect(evs.map((e) => e.name)).toEqual(["Now", "Oct"]);
  });

  it("company_report P&L: a key redactMoney removed stays absent, never 0", () => {
    const dash = { periods: [{ key: "2026-11", actual: { salesSen: 1000 } }] };
    expect(dashboardFigures(dash, ["2026-11"])).toEqual({ salesSen: 1000 });
    expect(dashboardFigures(dash, ["2026-10"])).toBeNull();
  });
});

const SALES = { rows: [{ venue: "PJ", so_date: today, amount_sen: 10000 }] };
const FULL_ERP: Partial<Record<string, Route>> = {
  "/api/scm/inventory/products": () => ok({ products: [{ item_code: "A", total_qty: 1, available_qty: 1, total_value_sen: 5000, unit_cost_sen: 2000 }] }),
  "/api/scm/inventory/warehouses": () => ok({ warehouses: [] }),
  "/api/scm/inventory/analytics": () => ok({ windowDays: 90, deadStock: [{ item_code: "D", qty: 1, valueSen: 300, avg_cost_sen: 300 }] }),
  "/api/scm/unbilled-deliveries": () => ok({ rows: [], totals: {}, buckets: [] }),
  "/api/scm/mfg-purchase-orders": () => ok({ total: 1, purchaseOrders: [{ id: "1", po_number: "PO-1", status: "SUBMITTED", lines: [{ qty: 1, remaining_qty: 1, unit_cost_sen: 700, location: "PJ" }] }] }),
  "/api/scm/mfg-sales-orders": () => ok({ salesOrders: [{ doc_no: "SO1", debtor_name: "Ali", status: "CONFIRMED", so_date: today, margin_sen: 100, balance_sen_live: 100 }] }),
  "/api/assr": () => ok({ total: 1, data: [{ id: 1, assr_no: "A1", stage: "qc", complained_date: today, contractor_cost: 5 }] }),
  "/api/scm/delivery-orders-mfg": () => ok({ deliveryOrders: [] }),
  "/api/assr/summary": () => ok({ active_count: 1, by_stage: [] }),
  "/api/assr/metrics/drill": () => ok({ cases: [] }),
  "/api/scm/reports/fair-report": () => ok(SALES),
  "/api/pos-admin/events": () => ok({ data: [{ project_id: 1, name: "E", status: "ON GOING" }] }),
  "/api/pos-admin/report": () => ok({ totals: { bills: 1, net_sen: 100, by_day: [] } }),
  "/api/scm/accounting/dashboard": () => ok({ periods: [{ key: "2026-11", actual: { salesSen: 1000, costOfSalesSen: 600, grossProfitSen: 400 } }] }),
  "/api/scm/accounting/ar-aging": () => ok({ rows: [], totals: {} }),
  "/api/scm/accounting/ap-aging": () => ok({ rows: [], totals: {} }),
};
const ARGS: Record<string, Record<string, unknown>> = { stock_check: { query: "BF" }, customer_overview: { query: "Ali" } };
const PERMISSION_TOOLS = [...ROUND4_TOOLS.map((t) => t.name), "outlet_sales", "pos_sales"];

describe("round-4 permissions: a low-privilege role never gets more than its ERP login", () => {
  it("every tool answers 'no access' when the ERP refuses the person", async () => {
    for (const name of PERMISSION_TOOLS) {
      const routes = Object.fromEntries(Object.keys(FULL_ERP).map((k) => [k, () => denied]));
      const { ctx } = fakeCtx(routes);
      // eslint-disable-next-line no-await-in-loop -- one tool at a time, so a failure names its tool
      const o = await runRound3Tool(ctx, name, ARGS[name] ?? {});
      expect(o.result.isError, name).toBe(true);
      expect(o.result.content[0].text, name).toMatch(/^You don't have access to /);
    }
  });

  it("a Sales Executive's answers carry no cost, margin or profit (redactMoney applied to each read)", async () => {
    const salesExec = { finance: false, productCost: false };
    const routes: Partial<Record<string, Route>> = { ...FULL_ERP, "/api/scm/accounting/dashboard": () => denied, "/api/scm/accounting/ar-aging": () => denied, "/api/scm/accounting/ap-aging": () => denied, "/api/scm/unbilled-deliveries": () => denied };
    for (const name of PERMISSION_TOOLS) {
      const { ctx } = fakeCtx(routes, salesExec);
      // eslint-disable-next-line no-await-in-loop -- one tool at a time, so a failure names its tool
      const text = (await runRound3Tool(ctx, name, ARGS[name] ?? {})).result.content[0].text;
      expect(text, name).not.toMatch(/"[^"]*(cost|margin|profit)[^"]*":\s*[-\d{]/i);
      expect(text, name).not.toContain('"remainingValueRm":');
    }
  });

  it("company_report for a non-finance role: no P&L or aging, says so, still answers sales and service", async () => {
    const { ctx } = fakeCtx({ ...FULL_ERP, "/api/scm/accounting/dashboard": () => denied, "/api/scm/accounting/ar-aging": () => denied, "/api/scm/accounting/ap-aging": () => denied });
    const b = body(await runRound3Tool(ctx, "company_report", { period: "month" }));
    expect(b.profitAndLoss).toBeNull();
    expect(b.receivables).toBeNull();
    expect(b.notAvailable).toEqual(["You don't have access to the financial statements (P&L).", "You don't have access to the debtor (AR) aging.", "You don't have access to the creditor (AP) aging."]);
    expect((b.salesOrders as { salesRm: number }).salesRm).toBe(100);
  });

  it("company_report for finance: P&L vs the previous month, at most six reads", async () => {
    const { ctx, calls } = fakeCtx(FULL_ERP, { finance: true, productCost: true });
    const b = body(await runRound3Tool(ctx, "company_report", { period: "month" }));
    expect(calls).toHaveLength(6);
    expect(b.profitAndLoss).toMatchObject({ salesRm: 10, costOfSalesRm: 6, grossProfitRm: 4, grossMarginPct: 40 });
    expect(calls.find((c) => c.path === "/api/scm/accounting/dashboard")?.q).toMatchObject({ granularity: "month", from: "2026-10", to: "2026-11" });
  });

  it("outlet_sales takes period and company reads the same three windows", async () => {
    const { ctx, calls } = fakeCtx(FULL_ERP);
    const b = body(await runRound3Tool(ctx, "outlet_sales", { period: "last_month" }));
    expect(calls.map((c) => [c.q?.date_from, c.q?.date_to])).toEqual([["2026-10-01", "2026-10-31"], ["2026-09-01", "2026-09-30"], ["2026-09-01", "2026-09-30"]]);
    expect(b.period).toBe("last_month");
    const bad = await runRound3Tool(ctx, "outlet_sales", { period: "fortnight" });
    expect(bad.result.isError).toBe(true);
  });
});
