import { describe, expect, test } from "vitest";
import { toDeviceSale } from "./pos-sale-read";

type Head = Parameters<typeof toDeviceSale>[0];
type Line = Parameters<typeof toDeviceSale>[1][number];
type Payment = Parameters<typeof toDeviceSale>[2][number];

const head = (over: Partial<Head> = {}): Head => ({
  id: 7, uuid: "11111111-1111-4111-8111-111111111111", company_id: 1, project_id: 2293, terminal_code: "T03", receipt_no: "T03-000001", type: "SALE", ref_sale_uuid: null,
  cashier_id: null, cashier_name: null, salesman_id: null, salesman_name: null, customer_name: "Lim", customer_phone: null,
  sold_at: "2026-11-19 07:09:12.5+00", subtotal_sen: 273870, item_discount_sen: 0, bill_discount_sen: 0, bill_discount_by: null,
  sst_applied: false, sst_rate: "8.00", sst_amount_sen: 0, rounding_sen: 0, total_sen: 273870, status: "PAID", void_reason: null, void_by: null, voided_at: null,
  is_test: false, source: "NORMAL", local_seq: null, stock_warning: null, synced_at: "2026-11-19 07:09:40+00", created_at: "2026-11-19 07:09:40+00", updated_at: "2026-11-19 07:09:40+00", ...over,
});
const line = (over: Partial<Line> = {}): Line => ({
  id: 1, sale_id: 7, line_no: 1, item_id: null, item_code: "AF LE CK BLU 4QFIT", description: "Affinity Leeann Cork Q", uom: "UNIT", qty: "5.000", unit_price_sen: 20970, original_price_sen: null,
  override_by: null, override_reason: null, discount_source: null, discount_type: null, discount_value: null, discount_by: null, discount_amount_sen: 0, is_foc: false, amount_sen: 104850, ...over,
});
const payment = (over: Partial<Payment> = {}): Payment => ({ id: 1, sale_id: 7, method: "QR", amount_sen: 273870, reference: null, last4: null, tendered_sen: null, change_sen: null, ...over });

describe("toDeviceSale", () => {
  test("a stored bill comes back in the shape the device prints: ISO times, numbers, lines in order", () => {
    const s = toDeviceSale(head(), [line({ id: 2, line_no: 2, item_code: "B", qty: "1.000", amount_sen: 23970, unit_price_sen: 23970 }), line()], [payment()], null);
    expect(s.sold_at).toBe("2026-11-19T07:09:12.500Z");
    expect(s.synced_at).toBe("2026-11-19T07:09:40.000Z");
    expect(s.sst_rate).toBe(8);
    expect(s.lines.map((l) => [l.line_no, l.code, l.qty])).toEqual([[1, "AF LE CK BLU 4QFIT", 5], [2, "B", 1]]);
    expect(s.payments).toEqual([{ method: "QR", amount_sen: 273870, reference: null, tendered_sen: null, change_sen: null }]);
    expect(s.customer_name).toBe("Lim");
  });
  test("what the ERP left empty reads as the device's own empties, never undefined", () => {
    const s = toDeviceSale(head(), [line()], [], null);
    expect([s.cashier_id, s.cashier_name, s.local_seq, s.lines[0].item_id]).toEqual([0, "", 0, 0]);
    expect([s.sync_error, s.returned, s.voided_at]).toEqual([null, null, null]);
  });
  test("a void and a return keep what the receipt prints about them", () => {
    const v = toDeviceSale(head({ status: "VOID", void_by: "Ummu", void_reason: "wrong item", voided_at: "2026-11-19 08:00:00+00" }), [], [], null);
    expect([v.status, v.void_by, v.void_reason, v.voided_at]).toEqual(["VOID", "Ummu", "wrong item", "2026-11-19T08:00:00.000Z"]);
    const r = toDeviceSale(head({ type: "RETURN", ref_sale_uuid: "22222222-2222-4222-8222-222222222222", total_sen: -23970 }), [line({ discount_type: "PCT", discount_value: "10.00", discount_amount_sen: 2397 })], [], "T03-000001");
    expect([r.type, r.ref_receipt_no, r.total_sen, r.lines[0].discount_value]).toEqual(["RETURN", "T03-000001", -23970, 10]);
  });
});
