import { describe, expect, test } from "vitest";
import {
  addItem, cartTotals, discLabel, emptyCart, findByBarcode, formatReceiptNo, holdExpired, lineAmountSen, manualDiscountNeedsSupervisor,
  nextHoldNo, overridePrice, removeLine, searchItems, setBillDiscount, setLineDiscount, setQty, toggleFoc,
} from "./cart";
import type { BundleItem } from "./types";

const item = (over: Partial<BundleItem> & { id: number }): BundleItem => ({
  product_id: `p${over.id}`, code: `C${over.id}`, name: `Item ${over.id}`, receipt_name: `Item ${over.id}`, uom: "UNIT", price_sen: 10000, list_price_sen: 10000,
  barcodes: [`955${over.id}`], discount: null, foc_allowed: true, max_manual_disc_pct: null, stock_qty: 5, ...over,
});

describe("cart", () => {
  test("a second scan adds +1 on a plain line, but never onto an overridden, FOC or manually discounted line", () => {
    let { cart } = addItem(emptyCart(false), item({ id: 1 }), true);
    ({ cart } = addItem(cart, item({ id: 1 }), true));
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]!.qty).toBe(2);
    cart = setLineDiscount(cart, 1, { source: "MANUAL", type: "PCT", value: 5 });
    ({ cart } = addItem(cart, item({ id: 1 }), true));
    expect(cart.lines).toHaveLength(2);
    const off = addItem(addItem(emptyCart(false), item({ id: 1 }), false).cart, item({ id: 1 }), false).cart;
    expect(off.lines).toHaveLength(2);
  });

  test("AUTO discount comes with the item; qty, FOC, override and removal renumber correctly", () => {
    let { cart } = addItem(emptyCart(false), item({ id: 1, discount: { type: "PCT", value: 10 } }), true);
    ({ cart } = addItem(cart, item({ id: 2 }), true));
    expect(discLabel(cart.lines[0]!)).toBe("-10%");
    expect(lineAmountSen(cart.lines[0]!)).toBe(9000);
    cart = setQty(cart, 1, 3);
    expect(lineAmountSen(cart.lines[0]!)).toBe(27000);
    cart = toggleFoc(cart, 2);
    expect(discLabel(cart.lines[1]!)).toBe("FOC");
    expect(lineAmountSen(cart.lines[1]!)).toBe(0);
    cart = overridePrice(cart, 1, 8000, "Aina", "damaged box");
    expect(cart.lines[0]!.original_price_sen).toBe(10000);
    expect(cart.lines[0]!.unit_price_sen).toBe(8000);
    cart = setQty(cart, 1, 0);
    expect(cart.lines.map((l) => l.line_no)).toEqual([1]);
    expect(cart.lines[0]!.code).toBe("C2");
    expect(removeLine(cart, 1).lines).toEqual([]);
  });

  test("RM discounts are per unit; totals apply item then bill discount, SST on the net, rounding only on cash", () => {
    let { cart } = addItem(emptyCart(false), item({ id: 1, price_sen: 5990 }), true);
    cart = setQty(cart, 1, 2);
    cart = setLineDiscount(cart, 1, { source: "MANUAL", type: "RM", value: 5 });
    ({ cart } = addItem(cart, item({ id: 2, price_sen: 15900 }), true));
    ({ cart } = addItem(cart, item({ id: 3, price_sen: 1500 }), true));
    cart = toggleFoc(cart, 3);
    cart = setBillDiscount(cart, { type: "PCT", value: 10 });
    const t = cartTotals(cart, 8, false);
    /* gross 11980 + 15900 = 27880; item disc 2 x 500 = 1000; bill 10% of 26880 = 2688 */
    expect(t.subtotal_sen).toBe(27880);
    expect(t.item_discount_sen).toBe(1000);
    expect(t.bill_discount_sen).toBe(2688);
    expect(t.net_sen).toBe(24192);
    expect(t.sst_sen).toBe(0);
    expect(t.total_sen).toBe(24192);
    expect(t.units).toBe(4);
    const sst = cartTotals({ ...cart, sst_applied: true }, 8, true);
    expect(sst.sst_sen).toBe(1935);
    expect(sst.rounding_sen).toBe(-2);
    expect(sst.total_sen).toBe(26125);
  });

  test("a manual discount above the cashier's cap, or the item's own cap, needs a supervisor", () => {
    expect(manualDiscountNeedsSupervisor({ type: "PCT", value: 10 }, 10000, 10, null)).toBe(false);
    expect(manualDiscountNeedsSupervisor({ type: "PCT", value: 11 }, 10000, 10, null)).toBe(true);
    expect(manualDiscountNeedsSupervisor({ type: "RM", value: 10 }, 10000, 10, null)).toBe(false);
    expect(manualDiscountNeedsSupervisor({ type: "RM", value: 20 }, 10000, 10, null)).toBe(true);
    expect(manualDiscountNeedsSupervisor({ type: "PCT", value: 8 }, 10000, 20, 5)).toBe(true);
    expect(manualDiscountNeedsSupervisor({ type: "RM", value: 1 }, 0, 0, null)).toBe(true);
  });

  test("lookup by barcode then code; search needs two characters and ranks prefix matches first", () => {
    const items = [item({ id: 1, name: "Pillow Soft", barcodes: ["9551", "2000000000015"] }), item({ id: 2, code: "BS-QN", name: "Bedsheet Queen" }), item({ id: 3, code: "PL-02", name: "Pillow Firm" })];
    expect(findByBarcode(items, "2000000000015")?.id).toBe(1);
    expect(findByBarcode(items, "bs-qn")?.id).toBe(2);
    expect(findByBarcode(items, "nope")).toBeNull();
    expect(searchItems(items, "p")).toEqual([]);
    expect(searchItems(items, "pl").map((i) => i.id)).toEqual([3]);
    expect(searchItems(items, "pil").map((i) => i.id)).toEqual([1, 3]);
    expect(searchItems(items, "queen").map((i) => i.id)).toEqual([2]);
  });

  test("receipt numbers follow the format; test mode gets a T prefix", () => {
    expect(formatReceiptNo("{TERM}-{000000}", "T02", 279, false)).toBe("T02-000279");
    expect(formatReceiptNo("{TERM}-{000000}", "T02", 1, true)).toBe("T02-T00001");
    expect(formatReceiptNo("HZ{TERM}/{0000}", "T1", 12, false)).toBe("HZT1/0012");
  });

  test("hold numbers count up; a held bill expires after the event's last day", () => {
    const h = { hold_no: "HOLD-03", created_at: "", cart: emptyCart(false), cashier: "x" };
    expect(nextHoldNo([])).toBe("HOLD-01");
    expect(nextHoldNo([h, { ...h, hold_no: "HOLD-01" }])).toBe("HOLD-04");
    expect(holdExpired(h, "2026-10-20", Date.parse("2026-10-20T15:59:00Z"))).toBe(false);
    expect(holdExpired(h, "2026-10-20", Date.parse("2026-10-20T16:00:01Z"))).toBe(true);
    expect(holdExpired(h, null, Date.now())).toBe(false);
  });
});
