// The POS Admin rules: PIN shape, code minting, event status word, and the
// Excel import row.
import { describe, expect, test } from "vitest";
import { isPosCashierPin, nextCode, parseImportRow, posEventStatus } from "./pos-admin-rules";

describe("pos-admin-rules", () => {
  test("a PIN is 4 to 6 digits", () => {
    expect(isPosCashierPin("1234")).toBe(true);
    expect(isPosCashierPin("123456")).toBe(true);
    expect(isPosCashierPin("123")).toBe(false);
    expect(isPosCashierPin("1234567")).toBe(false);
    expect(isPosCashierPin("12a4")).toBe(false);
    expect(isPosCashierPin(1234)).toBe(false);
  });

  test("codes fill the first gap", () => {
    expect(nextCode("T", [])).toBe("T01");
    expect(nextCode("T", ["T01", "t02"])).toBe("T03");
    expect(nextCode("C", ["C01", "C03"])).toBe("C02");
  });

  test("event status follows the link and the dates", () => {
    expect(posEventStatus({ linked: false, start_date: "2026-10-01", end_date: "2026-10-20" }, "2026-10-14")).toBe("NOT LINKED");
    expect(posEventStatus({ linked: true, start_date: "2026-10-01", end_date: "2026-10-20" }, "2026-10-14")).toBe("RUNNING");
    expect(posEventStatus({ linked: true, start_date: "2026-10-01", end_date: "2026-10-13" }, "2026-10-14")).toBe("ENDED");
    expect(posEventStatus({ linked: true, start_date: "2026-10-20", end_date: null }, "2026-10-14")).toBe("UPCOMING");
    expect(posEventStatus({ linked: true, start_date: null, end_date: null }, "2026-10-14")).toBe("RUNNING");
  });

  test("an import row maps the sheet's columns, RM to sen, % or RM discounts, and refuses what it cannot read", () => {
    const ok = parseImportRow({ "Item Code": "PL-01", Barcode: "9555123456789", UOM: "pc", "Price (RM)": "59.90", Cost: "20", "Discount Type": "%", "Discount Value": "10", FOC: "Y", "Max Manual Disc": "15", "Receipt Name": "Pillow Soft Extra Long Name Here", Active: "yes" });
    expect(ok).toEqual({
      ok: true, item_code: "PL-01", barcode: "9555123456789",
      fields: { uom: "PC", price_sen: 5990, cost_sen: 2000, preset_discount_type: "PCT", preset_discount_value: 10, foc_allowed: true, max_manual_disc_pct: 15, receipt_name: "Pillow Soft Extra Long N", active: true },
    });
    expect(parseImportRow({ item_code: "A", discount: "5" })).toMatchObject({ ok: true, fields: { preset_discount_type: "RM", preset_discount_value: 5 } });
    expect(parseImportRow({ Price: "10" })).toEqual({ ok: false, item_code: null, reason: "item code missing" });
    expect(parseImportRow({ "Item Code": "A", "Discount Type": "GOLD", "Discount Value": "5" })).toMatchObject({ ok: false, reason: 'discount type "GOLD" is not % or RM' });
    expect(parseImportRow({ "Item Code": "A", "Discount Type": "%", "Discount Value": "150" })).toMatchObject({ ok: false, reason: "discount above 100%" });
    expect(parseImportRow({ "Item Code": "A", Price: "-1" })).toMatchObject({ ok: false, reason: "price below zero" });
    expect(parseImportRow({ "Item Code": "A", Barcode: "x" })).toMatchObject({ ok: true, barcode: null });
  });
});
