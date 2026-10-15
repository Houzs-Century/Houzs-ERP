import { describe, expect, test } from "vitest";
import { addItem, emptyCart, setLineDiscount, setQty, toggleFoc } from "./cart";
import { buildReturn, buildSale, checkPayment, mytDate, returnTotals, returnableQty, returnWindowOpen, splitBalance, stockDeltas, voidAllowed, voidSale, type PaymentDraft, type SaleContext } from "./sale";
import type { BundleItem } from "./types";

const item = (over: Partial<BundleItem> & { id: number }): BundleItem => ({
  product_id: `p${over.id}`, code: `C${over.id}`, name: `Item ${over.id}`, receipt_name: `Item ${over.id}`, uom: "UNIT", price_sen: 10000, list_price_sen: 10000,
  barcodes: [], discount: null, foc_allowed: true, max_manual_disc_pct: null, stock_qty: 5, ...over,
});
const ctx: SaleContext = { uuid: "u-1", terminal_code: "T02", project_id: 9, cashier: { id: 2, name: "Farah" }, receipt_format: "{TERM}-{000000}", counter: 279, is_test: false, now: "2026-10-14T06:00:00.000Z" };
const pay = (method: PaymentDraft["method"], amount_sen: number, over: Partial<PaymentDraft> = {}): PaymentDraft => ({ method, amount_sen, reference: "", tendered_sen: null, ...over });

function cart() {
  let { cart } = addItem(emptyCart(false), item({ id: 1, price_sen: 5990 }), true);
  cart = setQty(cart, 1, 2);
  cart = setLineDiscount(cart, 1, { source: "MANUAL", type: "PCT", value: 10 });
  ({ cart } = addItem(cart, item({ id: 2, price_sen: 1500 }), true));
  cart = toggleFoc(cart, 2);
  return cart; /* 119.80 - 11.98 = 107.82, FOC mug */
}

describe("payment", () => {
  test("one cashless line must equal the total; a split's second line takes the balance; two lines max, different methods", () => {
    const c = cart();
    expect(checkPayment(c, 8, true, [])).toMatchObject({ ok: false, reason: "Choose a payment method" });
    expect(checkPayment(c, 8, true, [pay("QR", 10000)])).toMatchObject({ ok: false, reason: "Balance RM 7.82 outstanding" });
    expect(checkPayment(c, 8, true, [pay("QR", 10782)])).toMatchObject({ ok: true, total_sen: 10782, rounding_sen: 0, change_sen: 0 });
    expect(splitBalance(10782, 5000)).toBe(5782);
    expect(checkPayment(c, 8, true, [pay("QR", 5000), pay("CREDIT", 5782)])).toMatchObject({ ok: true });
    expect(checkPayment(c, 8, true, [pay("QR", 5000), pay("QR", 5782)])).toMatchObject({ ok: false, reason: "Use two different methods to split" });
    expect(checkPayment(c, 8, true, [pay("QR", 1), pay("CREDIT", 1), pay("DEBIT", 1)])).toMatchObject({ ok: false });
  });

  test("cash rounds the total to 5 sen and computes change; rounding off leaves the sen", () => {
    const c = cart();
    const r = checkPayment(c, 8, true, [pay("CASH", 10780, { tendered_sen: 15000 })]);
    expect(r).toMatchObject({ ok: true, total_sen: 10780, rounding_sen: -2, change_sen: 4220 });
    expect(checkPayment(c, 8, false, [pay("CASH", 10782, { tendered_sen: 10782 })])).toMatchObject({ ok: true, total_sen: 10782, change_sen: 0 });
    expect(checkPayment(c, 8, true, [pay("CASH", 10780, { tendered_sen: 10000 })])).toMatchObject({ ok: false, reason: "Cash tendered is below the cash amount" });
  });

  test("the sale record carries the receipt number, lines with their discount words, FOC, payments and stock deltas", () => {
    const s = buildSale(cart(), 8, true, [pay("QR", 10782, { reference: "A1B2" })], ctx);
    expect(s.receipt_no).toBe("T02-000279");
    expect(s.total_sen).toBe(10782);
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]).toMatchObject({ code: "C1", qty: 2, discount_source: "MANUAL", discount_type: "PCT", discount_value: 10, discount_amount_sen: 1198, amount_sen: 10782 });
    expect(s.lines[1]).toMatchObject({ code: "C2", is_foc: true, amount_sen: 0, discount_amount_sen: 1500, discount_type: null });
    expect(s.payments).toEqual([{ method: "QR", amount_sen: 10782, reference: "A1B2", tendered_sen: null, change_sen: null }]);
    expect(Array.from(stockDeltas(s))).toEqual([[1, -2], [2, -1]]);
    expect(buildSale(cart(), 8, true, [pay("QR", 10782)], { ...ctx, is_test: true }).receipt_no).toBe("T02-T00279");
    expect(() => buildSale(cart(), 8, true, [pay("QR", 1)], ctx)).toThrow(/Balance/);
  });
});

describe("void", () => {
  test("any time or same day by rule; a void bill restores stock on sync and cannot be voided twice", () => {
    const s = buildSale(cart(), 8, true, [pay("QR", 10782)], ctx);
    expect(voidAllowed(s, "SUPERVISOR_ANY_TIME", "2026-10-20")).toEqual({ ok: true });
    expect(voidAllowed(s, "SUPERVISOR_SAME_DAY", "2026-10-14")).toEqual({ ok: true });
    expect(voidAllowed(s, "SUPERVISOR_SAME_DAY", "2026-10-15")).toMatchObject({ ok: false });
    const v = voidSale(s, "Aina", "wrong item", "2026-10-14T07:00:00.000Z");
    expect(v.status).toBe("VOID");
    expect(v.synced_at).toBeNull();
    expect(voidAllowed(v, "SUPERVISOR_ANY_TIME", "2026-10-14")).toMatchObject({ ok: false, reason: "Already void" });
    expect(mytDate("2026-10-14T17:00:00.000Z")).toBe("2026-10-15");
  });
});

describe("return / exchange", () => {
  const original = buildSale(cart(), 8, true, [pay("CREDIT", 10782)], ctx);

  test("returnable qty is sold minus prior returns, FOC never", () => {
    expect(Array.from(returnableQty(original, []))).toEqual([[1, 2]]);
    const r1 = buildReturn(original, [{ line_no: 1, qty: 1, reason: "defect" }], null, 8, [], { ...ctx, uuid: "u-2", counter: 280 });
    expect(Array.from(returnableQty(original, [r1]))).toEqual([[1, 1]]);
  });

  test("a refund-only return refunds the sold net value to the original method; the receipt is R- numbered and gives stock back", () => {
    const r = buildReturn(original, [{ line_no: 1, qty: 1, reason: "defect" }], null, 8, [], { ...ctx, uuid: "u-2", counter: 280 });
    expect(r.receipt_no).toBe("R-T02-000280");
    expect(r.ref_receipt_no).toBe("T02-000279");
    expect(r.total_sen).toBe(-5391);
    expect(r.payments).toEqual([{ method: "CREDIT", amount_sen: -5391, reference: null, tendered_sen: null, change_sen: null }]);
    expect(r.lines[0]).toMatchObject({ code: "C1", qty: -1, amount_sen: -5391 });
    expect(Array.from(stockDeltas(r))).toEqual([[1, 1]]);
    expect(returnTotals(original, [{ line_no: 1, qty: 2, reason: "x" }], null, 8)).toEqual({ refund_sen: 10782, new_sen: 0, difference_sen: -10782 });
  });

  test("an exchange nets the new item against the refund: positive is paid, stock moves both ways", () => {
    const { cart: newCart } = addItem(emptyCart(false), item({ id: 3, price_sen: 15900 }), true);
    const t = returnTotals(original, [{ line_no: 1, qty: 1, reason: "size" }], newCart, 8);
    expect(t).toEqual({ refund_sen: 5391, new_sen: 15900, difference_sen: 10509 });
    const r = buildReturn(original, [{ line_no: 1, qty: 1, reason: "size" }], newCart, 8, [pay("QR", 10509)], { ...ctx, uuid: "u-3", counter: 281 });
    expect(r.total_sen).toBe(10509);
    expect(r.payments).toEqual([{ method: "QR", amount_sen: 10509, reference: null, tendered_sen: null, change_sen: null }]);
    expect(Array.from(stockDeltas(r))).toEqual([[1, 1], [3, -1]]);
  });

  test("the return window follows the setting and the event", () => {
    expect(returnWindowOpen(original, "EVENT", "2026-10-20", "2026-10-18T00:00:00Z")).toEqual({ ok: true });
    expect(returnWindowOpen(original, "EVENT", "2026-10-20", "2026-10-21T00:00:00Z")).toMatchObject({ ok: false });
    expect(returnWindowOpen(original, "SAME_DAY", null, "2026-10-14T10:00:00Z")).toEqual({ ok: true });
    expect(returnWindowOpen(original, "SAME_DAY", null, "2026-10-15T10:00:00Z")).toMatchObject({ ok: false });
    expect(returnWindowOpen(voidSale(original, "a", "b", "2026-10-14T07:00:00Z"), "EVENT", null, "2026-10-14T08:00:00Z")).toMatchObject({ ok: false, reason: "That bill is void" });
  });
});
