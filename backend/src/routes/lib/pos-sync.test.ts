// The sales batch's rules: the shape a device may send, how a repeat is
// classified, and the inventory movements a receipt produces.
import { describe, expect, test } from "vitest";
import { auditEntriesFor, classifyIncoming, movementsFor, parseIncomingSale, voidMovementsFor } from "./pos-sync";

const line = (over: Record<string, unknown> = {}) => ({ line_no: 1, item_id: 5, code: "PL-01", description: "Pillow", uom: "UNIT", qty: 2, unit_price_sen: 5990, original_price_sen: null, override_by: null, override_reason: null, discount_source: null, discount_type: null, discount_value: null, discount_amount_sen: 0, is_foc: false, amount_sen: 11980, ...over });
const raw = (over: Record<string, unknown> = {}) => ({
  uuid: "3F2504E0-4F89-11D3-9A0C-0305E82C3301", type: "SALE", ref_sale_uuid: null, receipt_no: "T02-000279", terminal_code: "T02", project_id: 9,
  cashier_id: 2, cashier_name: "Farah", salesman_id: null, salesman_name: null, customer_name: null, customer_phone: null, sold_at: "2026-10-14T06:00:00.000Z",
  subtotal_sen: 11980, item_discount_sen: 0, bill_discount_sen: 0, sst_applied: false, sst_rate: 0, sst_amount_sen: 0, rounding_sen: 0, total_sen: 11980,
  status: "PAID", void_reason: null, void_by: null, voided_at: null, is_test: false, local_seq: 279,
  lines: [line()], payments: [{ method: "QR", amount_sen: 11980, reference: "A1", tendered_sen: null, change_sen: null }], ...over,
});

describe("parseIncomingSale", () => {
  test("accepts the device's record and normalises it", () => {
    const r = parseIncomingSale(raw());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sale.uuid).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(r.sale.lines[0]).toMatchObject({ code: "PL-01", qty: 2, amount_sen: 11980 });
    expect(r.sale.payments[0]).toMatchObject({ method: "QR", amount_sen: 11980, reference: "A1" });
  });
  test("refuses what the ERP cannot book", () => {
    expect(parseIncomingSale(raw({ uuid: "x" }))).toMatchObject({ ok: false, reason: "uuid missing" });
    expect(parseIncomingSale(raw({ is_test: true }))).toMatchObject({ ok: false, reason: "test sale never syncs" });
    expect(parseIncomingSale(raw({ lines: [] }))).toMatchObject({ ok: false, reason: "no lines" });
    expect(parseIncomingSale(raw({ lines: [line({ qty: 1.5 })] }))).toMatchObject({ ok: false });
    expect(parseIncomingSale(raw({ payments: [{ method: "GOLD", amount_sen: 1 }] }))).toMatchObject({ ok: false, reason: "payment 1: unknown method" });
    expect(parseIncomingSale(raw({ payments: [{ method: "QR", amount_sen: 100 }] }))).toMatchObject({ ok: false, reason: "payments 100 do not equal total 11980" });
    expect(parseIncomingSale(raw({ total_sen: 11.5 }))).toMatchObject({ ok: false });
    expect(parseIncomingSale(raw({ status: "VOID", payments: [] })).ok).toBe(true);
  });
});

describe("classifyIncoming", () => {
  const r = parseIncomingSale(raw());
  const sale = r.ok ? r.sale : (() => { throw new Error("fixture"); })();
  const stored = { id: 1, status: "PAID" as const, salesman_id: null, salesman_name: null, terminal_code: "T02", receipt_no: "T02-000279" };
  test("new, duplicate, void once, salesman change, conflicts", () => {
    expect(classifyIncoming(sale, null, false)).toEqual({ kind: "new" });
    expect(classifyIncoming(sale, null, true)).toMatchObject({ kind: "conflict" });
    expect(classifyIncoming(sale, stored, false)).toEqual({ kind: "duplicate" });
    expect(classifyIncoming({ ...sale, status: "VOID" }, stored, false)).toMatchObject({ kind: "void" });
    expect(classifyIncoming({ ...sale, status: "VOID" }, { ...stored, status: "VOID" }, false)).toEqual({ kind: "duplicate" });
    expect(classifyIncoming({ ...sale, salesman_id: 3 }, stored, false)).toMatchObject({ kind: "salesman" });
    expect(classifyIncoming(sale, { ...stored, receipt_no: "T02-000001" }, false)).toMatchObject({ kind: "conflict" });
  });
});

describe("movements", () => {
  test("a sale takes stock OUT per line (FOC too); a return brings its negative lines IN and exchanges OUT; a void reverses", () => {
    const r = parseIncomingSale(raw({ lines: [line(), line({ line_no: 2, code: "GF-01", qty: 1, is_foc: true, amount_sen: 0, discount_amount_sen: 1500 })] }));
    const sale = r.ok ? r.sale : (() => { throw new Error("fixture"); })();
    expect(movementsFor(sale)).toEqual([
      { movement_type: "OUT", item_code: "PL-01", product_name: "Pillow", qty: 2, source_doc_type: "POS_SALE", source_doc_no: "T02-000279", notes: "POS sale T02-000279" },
      { movement_type: "OUT", item_code: "GF-01", product_name: "Pillow", qty: 1, source_doc_type: "POS_SALE", source_doc_no: "T02-000279", notes: "POS sale T02-000279" },
    ]);
    const ret = parseIncomingSale(raw({ type: "RETURN", receipt_no: "R-T02-000280", total_sen: 4009, lines: [line({ qty: -1, amount_sen: -5990 }), line({ line_no: 2, code: "BS-QN", qty: 1, amount_sen: 9999, unit_price_sen: 9999 })], payments: [{ method: "QR", amount_sen: 4009 }] }));
    const rs = ret.ok ? ret.sale : (() => { throw new Error("fixture"); })();
    expect(movementsFor(rs).map((m) => [m.movement_type, m.item_code, m.qty, m.source_doc_type])).toEqual([["IN", "PL-01", 1, "POS_RETURN"], ["OUT", "BS-QN", 1, "POS_RETURN"]]);
    expect(voidMovementsFor(sale).map((m) => [m.movement_type, m.qty, m.source_doc_type, m.notes])).toEqual([["IN", 2, "POS_VOID", "POS void T02-000279"], ["IN", 1, "POS_VOID", "POS void T02-000279"]]);
  });
});

describe("auditEntriesFor", () => {
  test("a supervisor price override and an above-cap discount each earn an audit row; a plain sale earns none", () => {
    const base = parseIncomingSale(raw());
    if (!base.ok) throw new Error(base.reason);
    expect(auditEntriesFor(base.sale, "POS T02")).toEqual([]);
    const s = { ...base.sale, bill_discount_sen: 500, bill_discount_by: "Aina", lines: base.sale.lines.map((l, i) => (i === 0 ? { ...l, original_price_sen: 5990, unit_price_sen: 4990, override_by: "Aina", override_reason: "display set", discount_source: "MANUAL" as const, discount_type: "PCT" as const, discount_value: 20, discount_by: "Aina" } : l)) };
    const rows = auditEntriesFor(s, "POS T02");
    expect(rows.map((r) => r.field)).toEqual([`price_override:${s.lines[0]!.line_no}:${s.lines[0]!.code}`, `discount_above_cap:${s.lines[0]!.line_no}:${s.lines[0]!.code}`, "bill_discount_above_cap"]);
    expect(rows[0]).toMatchObject({ from_value: "5990", to_value: "4990", by_name: "Aina (POS T02) display set" });
    expect(rows[1]).toMatchObject({ to_value: "20%", by_name: `Aina (POS T02) for ${s.cashier_name}` });
  });
});
