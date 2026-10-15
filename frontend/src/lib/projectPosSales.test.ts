import { describe, expect, test } from "vitest";
import {
  EMPTY_POS_FILTER,
  buildPosSalesExportRows,
  normalizeProjectPosSales,
  posNetRm,
  posReceiptStatusLabel,
  posSalesFilterQuery,
  type PosReceipt,
} from "./projectPosSales";

const receipt = (over: Partial<PosReceipt> & { receipt_no: string }): PosReceipt => ({
  id: 1, uuid: "u", type: "SALE", ref_sale_uuid: null, terminal_code: "T02", cashier_id: 1, cashier_name: "Aina",
  salesman_id: null, salesman_name: null, customer_name: null, customer_phone: null, sold_at: "2026-10-14T06:00:00.000Z",
  subtotal_sen: 10000, item_discount_sen: 1000, bill_discount_sen: 0, sst_applied: false, sst_rate: 0, sst_amount_sen: 0,
  rounding_sen: 0, total_sen: 9000, status: "PAID", void_reason: null, void_by: null, voided_at: null, source: "NORMAL",
  synced_at: "", methods: ["QR"], lines: [], payments: [{ method: "QR", amount_sen: 9000, reference: null }], ...over,
});

describe("normalizeProjectPosSales", () => {
  test("a foreign shape is an empty, disabled read", () => {
    const r = normalizeProjectPosSales({ error: "nope" });
    expect(r.pos_enabled).toBe(false);
    expect(r.data).toEqual([]);
    expect(r.totals.net_sen).toBe(0);
    expect(r.options.terminals).toEqual([]);
  });
  test("keeps what the worker sent", () => {
    const r = normalizeProjectPosSales({ pos_enabled: true, data: [receipt({ receipt_no: "T02-000001" })], totals: { count: 1, net_sen: 9000 }, all_count: 1, options: { terminals: ["T02"], cashiers: [], methods: ["QR"] } });
    expect(r.pos_enabled).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.totals.count).toBe(1);
    expect(posNetRm(r.totals)).toBe(90);
  });
});

describe("posSalesFilterQuery", () => {
  test("only set fields travel", () => {
    expect(posSalesFilterQuery(EMPTY_POS_FILTER)).toBe("");
    expect(posSalesFilterQuery({ ...EMPTY_POS_FILTER, date: "2026-10-14", cashier_id: 3, status: "VOID" })).toBe("?date=2026-10-14&cashier=3&status=VOID");
  });
});

describe("posReceiptStatusLabel", () => {
  test("VOID beats RETURN beats PAID", () => {
    expect(posReceiptStatusLabel({ status: "VOID", type: "RETURN" })).toBe("VOID");
    expect(posReceiptStatusLabel({ status: "PAID", type: "RETURN" })).toBe("RETURN");
    expect(posReceiptStatusLabel({ status: "PAID", type: "SALE" })).toBe("PAID");
  });
});

describe("buildPosSalesExportRows", () => {
  test("one row per line with the bill repeated; a lineless bill still exports once", () => {
    const rows = buildPosSalesExportRows([
      receipt({
        receipt_no: "T02-000001",
        lines: [
          { line_no: 1, item_code: "A1", description: "Pillow", qty: 2, uom: "UNIT", unit_price_sen: 5000, original_price_sen: null, override_reason: null, disc_label: "-10%", discount_amount_sen: 1000, is_foc: false, amount_sen: 9000 },
        ],
      }),
      receipt({ id: 2, receipt_no: "T02-000002", status: "VOID", void_reason: "wrong item", lines: [] }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.slice(0, 3)).toEqual(["T02-000001", "2026-10-14T06:00:00.000Z", "SALE"]);
    expect(rows[0]![9]).toBe("A1");
    expect(rows[0]![13]).toBe(50);
    expect(rows[0]![14]).toBe("-10%");
    expect(rows[0]![20]).toBe(90);
    expect(rows[0]![21]).toBe("QR / DuitNow 90.00");
    expect(rows[1]![3]).toBe("VOID");
    expect(rows[1]![22]).toBe("wrong item");
  });
});
