// The POS settings document: defaults a device can rely on, a stored value
// that only overrides keys of the same type, and the receipt header lines.
import { describe, expect, test } from "vitest";
import { normalizePosSettings, normalizePosSettingsGroup, posSettingsDefaults, receiptHeaderLines } from "./pos-settings";

describe("pos-settings", () => {
  test("defaults: cash OFF, every cashless method ON, SST 8% unticked, 58 mm, 15 min logout, alerts to the office", () => {
    const d = posSettingsDefaults();
    expect(d.general.payment_methods).toEqual({ QR: true, CREDIT: true, DEBIT: true, EWALLET: true, CASH: false });
    expect(d.sst_receipt.sst_rate).toBe(8);
    expect(d.sst_receipt.sst_default_on).toBe(false);
    expect(d.sst_receipt.paper_width).toBe(58);
    expect(d.general.idle_logout_minutes).toBe(15);
    expect(d.general.alert_email).toBe("hello@houzscentury.com");
    expect(d.general.alert_pending_days).toBe(3);
    expect(d.general.booth_brands).toEqual(["AKEMI Cash & Carry", "AKEMI FRAGRANCE"]);
    expect(normalizePosSettingsGroup("general", { booth_brands: ["ZANOTTI", 7] }).booth_brands).toEqual(["ZANOTTI", "7"]);
    expect(normalizePosSettingsGroup("general", { booth_brands: "AKEMI" }).booth_brands).toEqual(["AKEMI Cash & Carry", "AKEMI FRAGRANCE"]);
  });

  test("a stored document overrides same-typed keys only; junk and unknown keys fall back", () => {
    const g = normalizePosSettingsGroup("general", {
      idle_logout_minutes: 30,
      price_override: "OFF",
      payment_methods: { CASH: true, QR: "yes", BITCOIN: true },
      alert_email: 42,
      surprise: 1,
      pos_store_warehouse_id: "abc-uuid",
    });
    expect(g.idle_logout_minutes).toBe(30);
    expect(g.price_override).toBe("OFF");
    expect(g.payment_methods).toEqual({ QR: true, CREDIT: true, DEBIT: true, EWALLET: true, CASH: true });
    expect(g.alert_email).toBe("hello@houzscentury.com");
    expect((g as Record<string, unknown>).surprise).toBeUndefined();
    expect(g.pos_store_warehouse_id).toBe("abc-uuid");
    expect(normalizePosSettingsGroup("sst_receipt", "corrupt").paper_width).toBe(58);
    expect(normalizePosSettingsGroup("sst_receipt", { paper_width: 72 }).paper_width).toBe(58);
    expect(normalizePosSettingsGroup("sst_receipt", { paper_width: 80, header_lines: ["A", 2] }).header_lines).toEqual(["A", "2"]);
    expect(normalizePosSettings({}).printer_scanner.beep).toBe(true);
  });

  test("the receipt header fills the event name and drops blank lines", () => {
    expect(receiptHeaderLines({ header_lines: ["{event name}", "  ", "Booth A12"] }, "AEON Tebrau C&C")).toEqual(["AEON Tebrau C&C", "Booth A12"]);
  });
});
