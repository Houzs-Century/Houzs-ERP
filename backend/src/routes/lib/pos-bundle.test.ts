// The device bundle's item rule: scope, event price, barcodes, inactive
// items; and the device token shape.
import { describe, expect, test } from "vitest";
import { buildBundleItems, deviceTokenHash, isDeviceToken, mintDeviceToken, type BundleItemSource } from "./pos-bundle";

const item = (over: Partial<BundleItemSource> & { id: number }): BundleItemSource => ({
  product_id: `p${over.id}`, item_code: `C${over.id}`, name: `Item ${over.id}`, uom: "UNIT", price_sen: 1000,
  preset_discount_type: null, preset_discount_value: null, foc_allowed: false, max_manual_disc_pct: null, receipt_name: null, active: true, ...over,
});

describe("buildBundleItems", () => {
  test("ships active items in scope with the event price, the live SKU code and every barcode once", () => {
    const out = buildBundleItems(
      [item({ id: 1, preset_discount_type: "PCT", preset_discount_value: 10 }), item({ id: 2, active: false }), item({ id: 3, receipt_name: "Short" })],
      { catalog_scope: "ALL", pick_item_ids: [], price_overrides: new Map([[1, 800]]) },
      new Map([["p1", { code: "C1-NEW", name: "Item 1 renamed", barcode: "9555", stock_qty: 4 }]]),
      new Map([["p1", "2000000000015"], ["p3", "9555"]]),
      new Map([[1, ["9555", "EXTRA-1"]]]),
    );
    expect(out.map((i) => i.code)).toEqual(["C1-NEW", "C3"]);
    const a = out[0]!;
    expect(a.name).toBe("Item 1 renamed");
    expect(a.price_sen).toBe(800);
    expect(a.list_price_sen).toBe(1000);
    expect(a.barcodes).toEqual(["9555", "2000000000015", "EXTRA-1"]);
    expect(a.discount).toEqual({ type: "PCT", value: 10 });
    expect(a.stock_qty).toBe(4);
    expect(out[1]!.receipt_name).toBe("Short");
    expect(out[1]!.barcodes).toEqual(["9555"]);
  });

  test("a pick list keeps only the picked items", () => {
    const out = buildBundleItems([item({ id: 1 }), item({ id: 2 })], { catalog_scope: "PICK", pick_item_ids: [2], price_overrides: new Map() }, new Map(), new Map(), new Map());
    expect(out.map((i) => i.id)).toEqual([2]);
  });
});

describe("device token", () => {
  test("is 64 hex chars and its hash is stable", async () => {
    const t = mintDeviceToken();
    expect(isDeviceToken(t)).toBe(true);
    expect(isDeviceToken(t.slice(1))).toBe(false);
    expect(await deviceTokenHash(t)).toBe(await deviceTokenHash(t));
    expect(await deviceTokenHash("a")).not.toBe(await deviceTokenHash("b"));
  });
});
