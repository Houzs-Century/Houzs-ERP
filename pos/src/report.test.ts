import { describe, expect, test } from "vitest";
import { inRange, localReport, rangeDays, toReportSale, zReportLines } from "./report";
import type { SaleRecord } from "./sale";
import type { DeviceState } from "./types";

const sale = (over: Partial<SaleRecord>): SaleRecord => ({
  uuid: "u1", type: "SALE", ref_sale_uuid: null, ref_receipt_no: null, receipt_no: "T02-000001", terminal_code: "T02", project_id: 9, cashier_id: 1, cashier_name: "Aina", salesman_id: 2, salesman_name: "Farah",
  customer_name: null, customer_phone: null, sold_at: "2026-10-14T06:00:00Z", subtotal_sen: 11980, item_discount_sen: 1198, bill_discount_sen: 0, bill_discount_by: null, sst_applied: false, sst_rate: 0, sst_amount_sen: 0, rounding_sen: 0,
  total_sen: 10782, status: "PAID", void_reason: null, void_by: null, voided_at: null, is_test: false, local_seq: 1,
  lines: [{ line_no: 1, item_id: 5, code: "PL-01", description: "Pillow", uom: "PCS", qty: 2, unit_price_sen: 5990, original_price_sen: 5990, override_by: null, override_reason: null, discount_source: "AUTO", discount_type: "PCT", discount_value: 10, discount_by: null, discount_amount_sen: 1198, is_foc: false, amount_sen: 10782 }],
  payments: [{ method: "QR", amount_sen: 10782, reference: null, tendered_sen: null, change_sen: null }],
  synced_at: null, sync_error: null, returned: null, ...over,
});

describe("device sales report", () => {
  test("ranges are Malaysia days; today, one date, or the whole event", () => {
    const ev = { start_date: "2026-10-10", end_date: "2026-10-20" };
    expect(rangeDays({ kind: "today" }, ev, "2026-10-14T17:30:00Z")).toMatchObject({ from: "2026-10-15", to: "2026-10-15" });
    expect(rangeDays({ kind: "date", date: "2026-10-12" }, ev, "2026-10-14T06:00:00Z")).toMatchObject({ from: "2026-10-12", to: "2026-10-12" });
    expect(rangeDays({ kind: "event" }, ev, "2026-10-14T06:00:00Z")).toMatchObject({ from: "2026-10-10", to: "2026-10-20" });
    expect(inRange({ sold_at: "2026-10-14T17:30:00Z" }, { from: "2026-10-15", to: "2026-10-15" })).toBe(true);
    expect(inRange({ sold_at: "2026-10-14T15:30:00Z" }, { from: "2026-10-15", to: "2026-10-15" })).toBe(false);
  });
  test("local bills aggregate through the shared report; test sales never count", () => {
    const t = localReport([sale({}), sale({ uuid: "t", is_test: true, receipt_no: "T02-T00001" }), sale({ uuid: "o", sold_at: "2026-10-01T06:00:00Z" })], { from: "2026-10-14", to: "2026-10-14" });
    expect(t.bills).toBe(1);
    expect(t.net_sen).toBe(10782);
    expect(t.by_method).toEqual([{ method: "QR", amount_sen: 10782, sales_sen: 10782, refund_sen: 0 }]);
    expect(toReportSale(sale({})).lines[0]).toMatchObject({ item_code: "PL-01", qty: 2 });
  });
  test("the Z-report carries the KPIs, methods with refunds, salesmen and the void list on the paper width", () => {
    const state = { bundle: { company: { name: "Houzs" }, event: { name: "AEON C&C" }, settings: { sst_receipt: { paper_width: 58 } } } } as unknown as DeviceState;
    const t = localReport([sale({}), sale({ uuid: "v", receipt_no: "T02-000002", status: "VOID", void_reason: "wrong item" }), sale({ uuid: "r", type: "RETURN", receipt_no: "R-T02-000003", ref_receipt_no: "T02-000001", total_sen: -5391, subtotal_sen: -5990, item_discount_sen: -599, lines: [], payments: [{ method: "QR", amount_sen: -5391, reference: null, tendered_sen: null, change_sen: null }] })], { from: "2026-10-14", to: "2026-10-14" });
    const text = zReportLines(t, { state, scope: "T02", rangeLabel: "Today 2026-10-14", printedAt: "14/10 18:00" }).map((l) => l.text);
    expect(text.every((l) => l.length <= 32)).toBe(true);
    expect(text).toContain("SALES REPORT");
    expect(text.find((l) => l.startsWith("NET SALES"))).toMatch(/53\.91$/);
    expect(text.find((l) => l.startsWith("  refunds"))).toMatch(/-53\.91$/);
    expect(text.find((l) => l.startsWith("NET RECEIVED"))).toMatch(/53\.91$/);
    expect(text).toContain("  wrong item");
    expect(text.find((l) => l.startsWith("Farah"))).toMatch(/^Farah \(1\)/);
  });
});
