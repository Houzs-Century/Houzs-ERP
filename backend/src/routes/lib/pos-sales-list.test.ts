// The POS Sales list a project page shows (layout E9): bills grouped by
// receipt, the Disc column's wording, the header totals, and the filters.
import { describe, expect, test } from "vitest";
import {
  discLabel,
  filterPosReceipts,
  groupPosReceipts,
  parsePosSalesFilter,
  posLocalDate,
  posSalesTotals,
  type PosPaymentRow,
  type PosSaleHeader,
  type PosSaleLineRow,
} from "./pos-sales-list";

const header = (over: Partial<PosSaleHeader> & { id: number; receipt_no: string }): PosSaleHeader => ({
  uuid: `u-${over.id}`, type: "SALE", ref_sale_uuid: null, terminal_code: "T02",
  cashier_id: 7, cashier_name: "Aina", salesman_id: null, salesman_name: null,
  customer_name: null, customer_phone: null, sold_at: "2026-10-14T06:00:00.000Z",
  subtotal_sen: 10000, item_discount_sen: 0, bill_discount_sen: 0, sst_applied: false, sst_rate: "0",
  sst_amount_sen: 0, rounding_sen: 0, total_sen: 10000, status: "PAID", void_reason: null, void_by: null,
  voided_at: null, source: "NORMAL", synced_at: "2026-10-14T06:01:00.000Z", ...over,
});
const line = (over: Partial<PosSaleLineRow> & { sale_id: number; line_no: number }): PosSaleLineRow => ({
  item_code: "A1", description: "Pillow", uom: "UNIT", qty: "1", unit_price_sen: 10000, original_price_sen: null,
  override_by: null, override_reason: null, discount_source: null, discount_type: null, discount_value: null,
  discount_amount_sen: 0, is_foc: false, amount_sen: 10000, ...over,
});
const pay = (over: Partial<PosPaymentRow> & { sale_id: number }): PosPaymentRow => ({
  method: "QR", amount_sen: 10000, reference: null, ...over,
});

describe("discLabel", () => {
  test("FOC beats everything; percent and RM print as the receipt does; none is --", () => {
    expect(discLabel(line({ sale_id: 1, line_no: 1, is_foc: true, discount_type: "PCT", discount_value: 10 }))).toBe("FOC");
    expect(discLabel(line({ sale_id: 1, line_no: 1, discount_type: "PCT", discount_value: "10" }))).toBe("-10%");
    expect(discLabel(line({ sale_id: 1, line_no: 1, discount_type: "RM", discount_value: 15 }))).toBe("-RM15");
    expect(discLabel(line({ sale_id: 1, line_no: 1, discount_amount_sen: 550 }))).toBe("-RM5.50");
    expect(discLabel(line({ sale_id: 1, line_no: 1 }))).toBe("--");
  });
});

describe("groupPosReceipts", () => {
  test("hangs lines and payments under their bill, lines in line order, newest bill first", () => {
    const rs = groupPosReceipts(
      [
        header({ id: 1, receipt_no: "T02-000001", sold_at: "2026-10-14T01:00:00.000Z" }),
        header({ id: 2, receipt_no: "T02-000002", sold_at: "2026-10-14T02:00:00.000Z" }),
      ],
      [line({ sale_id: 1, line_no: 2, item_code: "B" }), line({ sale_id: 1, line_no: 1, item_code: "A" })],
      [pay({ sale_id: 1, method: "QR", amount_sen: 6000 }), pay({ sale_id: 1, method: "CREDIT", amount_sen: 4000 })],
    );
    expect(rs.map((r) => r.receipt_no)).toEqual(["T02-000002", "T02-000001"]);
    const first = rs[1]!;
    expect(first.lines.map((l) => l.item_code)).toEqual(["A", "B"]);
    expect(first.lines[0]!.qty).toBe(1);
    expect(first.methods).toEqual(["QR", "CREDIT"]);
    expect(rs[0]!.lines).toEqual([]);
    expect(rs[0]!.methods).toEqual([]);
  });
});

describe("posSalesTotals", () => {
  test("net = PAID sales minus PAID returns; a VOID counts only as void; methods net of refunds", () => {
    const rs = groupPosReceipts(
      [
        header({ id: 1, receipt_no: "T02-000001", total_sen: 10000, item_discount_sen: 500, bill_discount_sen: 300, sst_amount_sen: 80 }),
        header({ id: 2, receipt_no: "T02-000002", total_sen: 4000, status: "VOID" }),
        header({ id: 3, receipt_no: "R-T02-000003", type: "RETURN", total_sen: 2500 }),
      ],
      [],
      [
        pay({ sale_id: 1, method: "QR", amount_sen: 10000 }),
        pay({ sale_id: 2, method: "QR", amount_sen: 4000 }),
        pay({ sale_id: 3, method: "QR", amount_sen: -2500 }),
      ],
    );
    const t = posSalesTotals(rs);
    expect(t.count).toBe(3);
    expect(t.paid_count).toBe(1);
    expect(t.void_count).toBe(1);
    expect(t.return_count).toBe(1);
    expect(t.sales_sen).toBe(10000);
    expect(t.return_sen).toBe(2500);
    expect(t.void_sen).toBe(4000);
    expect(t.net_sen).toBe(7500);
    expect(t.discount_sen).toBe(800);
    expect(t.sst_sen).toBe(80);
    expect(t.by_method).toEqual({ QR: 7500 });
  });

  test("an empty list is all zeros", () => {
    expect(posSalesTotals([])).toMatchObject({ count: 0, net_sen: 0, by_method: {} });
  });
});

describe("filters", () => {
  const rs = groupPosReceipts(
    [
      header({ id: 1, receipt_no: "T01-000001", terminal_code: "T01", cashier_id: 1, sold_at: "2026-10-13T17:00:00.000Z" }),
      header({ id: 2, receipt_no: "T02-000002", terminal_code: "T02", cashier_id: 2, sold_at: "2026-10-14T03:00:00.000Z" }),
      header({ id: 3, receipt_no: "T02-000003", terminal_code: "T02", cashier_id: 2, status: "VOID" }),
      header({ id: 4, receipt_no: "R-T02-000004", terminal_code: "T02", cashier_id: 2, type: "RETURN" }),
    ],
    [],
    [pay({ sale_id: 1, method: "CREDIT" }), pay({ sale_id: 2, method: "QR" }), pay({ sale_id: 3, method: "QR" })],
  );
  const none = parsePosSalesFilter({});

  test("the bill's date is Malaysia time, so 17:00Z on the 13th is the 14th", () => {
    expect(posLocalDate("2026-10-13T17:00:00.000Z")).toBe("2026-10-14");
    expect(posLocalDate("2026-10-13T15:59:00.000Z")).toBe("2026-10-13");
  });

  test("date, terminal, cashier, method and status each narrow the list", () => {
    expect(filterPosReceipts(rs, none)).toHaveLength(4);
    /* Newest first; 3 and 4 share a time so the receipt no breaks the tie;
       bill 1 is 01:00 on the 14th Malaysia time, the earliest of the day. */
    expect(filterPosReceipts(rs, { ...none, date: "2026-10-14" }).map((r) => r.id)).toEqual([3, 4, 2, 1]);
    expect(filterPosReceipts(rs, { ...none, terminal: "T01" }).map((r) => r.id)).toEqual([1]);
    expect(filterPosReceipts(rs, { ...none, cashier_id: 2 }).map((r) => r.id)).toEqual([3, 4, 2]);
    expect(filterPosReceipts(rs, { ...none, method: "QR" }).map((r) => r.id)).toEqual([3, 2]);
    expect(filterPosReceipts(rs, { ...none, status: "PAID" }).map((r) => r.id)).toEqual([2, 1]);
    expect(filterPosReceipts(rs, { ...none, status: "VOID" }).map((r) => r.id)).toEqual([3]);
    expect(filterPosReceipts(rs, { ...none, status: "RETURN" }).map((r) => r.id)).toEqual([4]);
  });

  test("a malformed query is no filter, not a refusal", () => {
    expect(parsePosSalesFilter({ date: "14/10/2026", cashier: "abc", method: "GOLD", status: "x" })).toEqual({
      date: null, terminal: null, cashier_id: null, method: null, status: null,
    });
    expect(parsePosSalesFilter({ date: "2026-10-14", terminal: " T02 ", cashier: "2", method: "QR", status: "VOID" })).toEqual({
      date: "2026-10-14", terminal: "T02", cashier_id: 2, method: "QR", status: "VOID",
    });
  });
});
