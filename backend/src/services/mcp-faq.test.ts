import { describe, it, expect } from "vitest";
import { foldCells, pagedRows, summariseAging, summariseDeliveriesDue, summarisePoOutstanding, summariseSoOverdue, summariseSupplierLateness, summariseUnbilled } from "./mcp-faq";
import { runRound3Tool, type R3Ctx, type R3Read } from "./mcp-round3";

const today = "2026-11-26";
const origin = "https://erp.example.test";
const ok = (value: unknown): R3Read => ({ ok: true, status: 200, value, removed: [], target: "" });
const denied: R3Read = { ok: false, status: 403, message: "Not available to your role", note: "no permission", target: "" };

function fakeCtx(routes: Partial<Record<string, (q: Record<string, unknown> | undefined) => R3Read>>, delayMs = 0) {
  const calls: { path: string; q: Record<string, unknown> | undefined }[] = [];
  const ctx: R3Ctx = {
    read: async (path, q) => {
      calls.push({ path, q });
      // eslint-disable-next-line houzs/no-imperative-timers -- a fake slow read: the test times it to prove the reads run in parallel
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const h = routes[path];
      return h ? h(q) : { ok: false, status: 404, message: "not found", note: "", target: path };
    },
    origin,
    userId: 7,
    bucket: {} as R3Ctx["bucket"],
    now: Date.parse("2026-11-26T04:00:00Z"),
  };
  return { ctx, calls };
}
const body = (o: { result: { content: { text: string }[] } }) => JSON.parse(o.result.content[0].text) as Record<string, unknown>;

describe("FAQ quick answers (pure)", () => {
  it("P1/P4 po_overdue: overdue by the latest supplier date, still-to-receive, by supplier", () => {
    const s = summarisePoOutstanding(
      [
        { id: "a", po_number: "PO1", status: "SUBMITTED", expected_at: "2026-11-10", total_sen: 10000, supplier: { name: "Acme" } },
        { id: "b", po_number: "PO2", status: "PARTIALLY_RECEIVED", expected_at: "2026-11-01", supplier_delivery_date_2: "2026-11-28", total_sen: 5000, supplier: { name: "Acme" } },
        { id: "c", po_number: "PO3", status: "SUBMITTED", expected_at: "2026-11-01", total_sen: 1, on_hold: true },
      ],
      today,
      origin,
      false,
    );
    expect(s.awaitingReceipt).toEqual({ pos: 2, partlyReceived: 1, valueRm: 150 });
    expect(s.overdue.pos).toBe(1);
    expect(s.overdue.top[0]).toMatchObject({ po: "PO1", daysLate: 16, valueRm: 100, url: `${origin}/scm/purchase-orders/a` });
    expect(s.dueThisWeek.top[0].po).toBe("PO2");
    expect(s.overdueBySupplier).toEqual([{ supplier: "Acme", pos: 1, valueRm: 100, worstDaysLate: 16 }]);
  });

  it("P2 supplier_lateness: received after the original date counts as late", () => {
    const s = summariseSupplierLateness(
      [
        { received_at: "2026-11-20T03:00:00Z", expected_at: "2026-11-15", supplier: { name: "Slow" } },
        { received_at: "2026-11-10T03:00:00Z", expected_at: "2026-11-15", supplier: { name: "Slow" } },
        { received_at: "2026-11-10T03:00:00Z", expected_at: "2026-11-15", supplier: { name: "Fast" } },
        { received_at: "2026-05-10T03:00:00Z", expected_at: "2026-05-01", supplier: { name: "Old" } },
      ],
      [{ expected_at: "2026-11-01", supplier: { name: "Fast" } }],
      "2026-08-29",
      today,
    );
    expect(s.receivedPosInWindow).toBe(3);
    expect(s.suppliers).toEqual([
      { supplier: "Slow", receivedPos: 2, lateDeliveries: 1, onTimePct: 50, avgDaysLate: 5, openPosPastDate: 0 },
      { supplier: "Fast", receivedPos: 1, lateDeliveries: 0, onTimePct: 100, avgDaysLate: 0, openPosPastDate: 1 },
    ]);
  });

  it("P3 / S3 aging: five day columns fold to four, due this week and past due by due date", () => {
    expect(foldCells([100, 200, 300, 400, 500])).toEqual({ "0-30": 1, "31-60": 2, "61-90": 3, "90+": 9 });
    const s = summariseAging(
      {
        asOf: today,
        totals: { balanceSen: 30000, cells: [10000, 0, 0, 0, 20000] },
        rows: [{ name: "Acme", balanceSen: 30000, cells: [10000, 0, 0, 0, 20000], items: [{ docNo: "PI1", dueDate: "2026-11-28", openSen: 10000 }, { docNo: "PI0", dueDate: "2026-06-01", openSen: 20000 }, { docNo: "PI9", dueDate: null, openSen: 5 }] }],
      },
      today,
      "supplier",
    );
    expect(s).toMatchObject({ totalRm: 300, pastDueRm: 200, dueThisWeekRm: 100, aged: { "0-30": 100, "90+": 200 } });
    expect(s.dueThisWeek).toEqual([{ party: "Acme", doc: "PI1", dueDate: "2026-11-28", openRm: 100 }]);
    expect((s as unknown as { bySupplier: unknown[] }).bySupplier).toHaveLength(1);
    expect(summariseUnbilled({ totals: { rows: 1, unbilled_sen: 990 }, buckets: [{ label: "0-30 days", rows: 1, unbilled_sen: 990 }], rows: [{ do_number: "DO1", age_days: 3, unbilled_sen: 990 }] })).toMatchObject({ deliveryOrders: 1, unbilledRm: 9.9 });
  });

  it("S1 so_overdue and S2 deliveries_due", () => {
    const sos = [
      { doc_no: "S1", status: "CONFIRMED", customer_delivery_date: "2026-11-20", agent: "Ann", local_total_sen: 100000 },
      { doc_no: "S2", status: "READY_TO_SHIP", customer_delivery_date: "2026-11-26", agent: "Ben", local_total_sen: 100 },
      { doc_no: "S3", status: "CONFIRMED", customer_delivery_date: "2026-11-30", local_total_sen: 100 },
    ];
    const o = summariseSoOverdue(sos, today, origin, false);
    expect(o).toMatchObject({ overdue: 1, valueRm: 1000, bySalesperson: [{ salesperson: "Ann", orders: 1 }] });
    expect(o.top[0]).toMatchObject({ so: "S1", daysLate: 6 });
    const d = summariseDeliveriesDue(
      [
        { id: "d1", do_number: "DO1", so_doc_no: "S2", customer_delivery_date: "2026-11-26", status: "LOADED" },
        { id: "d2", do_number: "DO2", so_doc_no: "S9", customer_delivery_date: "2026-11-26", status: "DELIVERED" },
      ],
      sos,
      today,
      origin,
    );
    expect(d.today).toEqual({ deliveryOrders: 1, salesOrdersWithoutDo: 0 });
    expect(d.thisWeek).toEqual({ deliveryOrders: 1, salesOrdersWithoutDo: 1 });
    expect(d.salesOrdersWithoutDo[0].so).toBe("S3");
  });
});

describe("FAQ tools through a fake ERP", () => {
  it("pages stop once the dates pass the horizon", async () => {
    let reads = 0;
    const { ctx } = fakeCtx({
      "/api/scm/mfg-sales-orders": (q) => {
        reads += 1;
        const p = Number(q?.page);
        return ok({ total: 900, salesOrders: Array.from({ length: 100 }, (_, i) => ({ doc_no: `S${p}-${i}`, customer_delivery_date: p === 0 ? "2026-11-01" : "2027-01-01" })) });
      },
    });
    const got = await pagedRows(ctx, "/api/scm/mfg-sales-orders", "salesOrders", {}, 9, (last) => String(last.customer_delivery_date) > "2026-11-25");
    expect(got.ok && got.rows.length).toBe(500);
    expect(got.ok && got.truncated).toBe(false);
    expect(reads).toBe(5);
  });

  it("so_overdue reads the three open tabs at once", async () => {
    const { ctx, calls } = fakeCtx({ "/api/scm/mfg-sales-orders": (q) => ok({ total: 1, salesOrders: [{ doc_no: `X-${String(q?.status)}`, status: q?.status, customer_delivery_date: "2026-11-01" }] }) }, 30);
    const t0 = performance.now();
    const b = body(await runRound3Tool(ctx, "so_overdue", {}));
    expect(performance.now() - t0).toBeLessThan(90);
    expect(calls.map((c) => c.q?.status)).toEqual(["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP"]);
    expect(b.overdue).toBe(3);
  });

  it("payables_summary for a non-finance person says so plainly", async () => {
    const { ctx } = fakeCtx({ "/api/scm/accounting/ap-aging": () => denied });
    const o = await runRound3Tool(ctx, "payables_summary", {});
    expect(o.result.isError).toBe(true);
    expect(o.result.content[0].text).toBe("You don't have access to the creditor (AP) aging in the ERP.");
  });

  it("receivables_summary keeps the half the person may see", async () => {
    const { ctx } = fakeCtx({ "/api/scm/accounting/ar-aging": () => denied, "/api/scm/unbilled-deliveries": () => ok({ totals: { rows: 0, unbilled_sen: 0 }, buckets: [], rows: [] }) });
    const b = body(await runRound3Tool(ctx, "receivables_summary", {}));
    expect(b.deliveredNotInvoiced).toBeDefined();
    expect(b.invoicedNotPaid).toBeUndefined();
    expect(b.notAvailable).toEqual(["You don't have access to the debtor (AR) aging."]);
  });

  it("deliveries_due and po_overdue answer from the lists", async () => {
    const { ctx } = fakeCtx({
      "/api/scm/delivery-orders-mfg": () => ok({ total: 1, deliveryOrders: [{ id: "d", do_number: "DO1", customer_delivery_date: today, status: "LOADED" }] }),
      "/api/scm/mfg-sales-orders": () => ok({ total: 0, salesOrders: [] }),
      "/api/scm/mfg-purchase-orders": () => ok({ total: 0, purchaseOrders: [] }),
    });
    expect(body(await runRound3Tool(ctx, "deliveries_due", {})).today).toEqual({ deliveryOrders: 1, salesOrdersWithoutDo: 0 });
    expect((body(await runRound3Tool(ctx, "po_overdue", {})).overdue as { pos: number }).pos).toBe(0);
    expect((body(await runRound3Tool(ctx, "supplier_lateness", { period: "this_month" })) as { from: string }).from).toBe("2026-11-01");
  });
});
