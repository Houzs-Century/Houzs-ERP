import { describe, expect, test } from "vitest";
import { posSettingsDefaults } from "@shared/pos-settings";
import { addItem, emptyCart, setLineDiscount, setQty, toggleFoc } from "./cart";
import { escposBytes } from "./escpos";
import { receiptColumns, receiptLines, receiptText, wrap } from "./receipt";
import { buildSale, voidSale, type SaleContext } from "./sale";
import type { BundleItem } from "./types";

const item = (over: Partial<BundleItem> & { id: number }): BundleItem => ({
  product_id: `p${over.id}`, code: `C${over.id}`, name: `Item ${over.id}`, receipt_name: `Item ${over.id}`, uom: "UNIT", price_sen: 10000, list_price_sen: 10000,
  barcodes: [], discount: null, foc_allowed: true, max_manual_disc_pct: null, stock_qty: 5, ...over,
});
const ctx: SaleContext = { uuid: "u-1", terminal_code: "T02", project_id: 9, cashier: { id: 2, name: "Farah" }, receipt_format: "{TERM}-{000000}", counter: 279, is_test: false, now: "2026-10-14T06:00:00.000Z" };
const company = { name: "HOUZS CENTURY SDN BHD", registration_no: "SSM 123456-X", address: "", phone: "" };

function sale(sstOn = false) {
  let { cart } = addItem(emptyCart(sstOn), item({ id: 1, price_sen: 5990, receipt_name: "Akemi Pillow Soft" }), true);
  cart = setQty(cart, 1, 2);
  cart = setLineDiscount(cart, 1, { source: "MANUAL", type: "PCT", value: 10 });
  ({ cart } = addItem(cart, item({ id: 2, price_sen: 1500, receipt_name: "Gift Mug" }), true));
  cart = toggleFoc(cart, 2);
  cart = { ...cart, salesman: { id: 3, name: "Farah" } };
  return buildSale(cart, 8, true, [{ method: "QR", amount_sen: sstOn ? 11645 : 10782, reference: "A1B2", tendered_sen: null }], ctx);
}

describe("receipt", () => {
  test("every line fits the paper at 58 and 80 mm and the AutoCount sections are all there", () => {
    const s = posSettingsDefaults().sst_receipt;
    for (const w of [58, 80] as const) {
      const lines = receiptLines(sale(), { company, event_name: "AEON Tebrau C&C", settings: { ...s, paper_width: w }, kind: "ORIGINAL" });
      expect(Math.max(...lines.map((l) => l.text.length))).toBeLessThanOrEqual(receiptColumns(w));
    }
    const text = receiptText(sale(), { company, event_name: "AEON Tebrau C&C", settings: s, kind: "ORIGINAL" });
    expect(text).toContain("HOUZS CENTURY SDN BHD");
    expect(text).toContain("SSM 123456-X");
    expect(text).toContain("AEON Tebrau C&C");
    expect(text).toContain("SALES INVOICE");
    expect(text).toContain("C1 Akemi Pillow Soft");
    expect(text).toMatch(/2 x 59\.90 = 119\.80/);
    expect(text).toMatch(/Discount 10%\s+-11\.98/);
    expect(text).toMatch(/C2 Gift Mug/);
    expect(text).toMatch(/FOC\s+-15\.00/);
    expect(text).toMatch(/Sub Total\s+119\.80/);
    expect(text).toMatch(/Total Discount\s+-11\.98/);
    expect(text).toMatch(/SST 8%\s+0\.00/);
    expect(text).toMatch(/FINAL TOTAL\s+107\.82/);
    expect(text).toMatch(/QR \/ DuitNow\s+107\.82/);
    expect(text).toContain("Ref A1B2");
    expect(text).toContain("Receipt# T02-000279");
    expect(text).toContain("Terminal T02");
    expect(text).toContain("Date 14/10/2026 02:00 PM");
    expect(text).toContain("Salesman Farah");
    expect(text).toContain("Cashier Farah");
    expect(text).not.toContain("COPY");
  });

  test("SST ticked prints the rate and registration; unticked with the setting off prints no SST line", () => {
    const s = { ...posSettingsDefaults().sst_receipt, sst_reg_no: "W10-1808-32000123" };
    const on = receiptText(sale(true), { company, event_name: "E", settings: s, kind: "ORIGINAL" });
    expect(on).toContain("SST No: W10-1808-32000123");
    expect(on).toMatch(/SST 8%\s+8\.63/);
    expect(on).toMatch(/FINAL TOTAL\s+116\.45/);
    const off = receiptText(sale(), { company, event_name: "E", settings: { ...s, show_sst_when_zero: false }, kind: "ORIGINAL" });
    expect(off).not.toMatch(/SST 8%/);
  });

  test("COPY, VOID and TEST markers; cash prints tendered and change", () => {
    const s = posSettingsDefaults().sst_receipt;
    expect(receiptText(sale(), { company, event_name: "E", settings: s, kind: "COPY" })).toContain("COPY");
    const v = receiptText(voidSale(sale(), "Aina", "wrong item", "2026-10-14T07:00:00Z"), { company, event_name: "E", settings: s, kind: "ORIGINAL" });
    expect(v).toContain("*** VOID ***");
    expect(v).toContain("VOID 14/10/2026 03:00 PM Aina wrong item");
    const t = buildSale(addItem(emptyCart(false), item({ id: 1 }), true).cart, 8, true, [{ method: "CASH", amount_sen: 10000, reference: "", tendered_sen: 15000 }], { ...ctx, is_test: true });
    const tt = receiptText(t, { company, event_name: "E", settings: s, kind: "ORIGINAL" });
    expect(tt).toContain("*** TEST ***");
    expect(tt).toMatch(/Cash Tendered\s+150\.00/);
    expect(tt).toMatch(/Change\s+50\.00/);
  });

  test("wrap keeps words whole and cuts a monster token", () => {
    expect(wrap("Akemi Pillow Soft Extra", 12)).toEqual(["Akemi Pillow", "Soft Extra"]);
    expect(wrap("ABCDEFGHIJKLMNOP", 8)).toEqual(["ABCDEFGH", "IJKLMNOP"]);
  });

  test("ESC/POS bytes start with init, end with a cut, and carry a Code 128 of the receipt no", () => {
    const lines = receiptLines(sale(), { company, event_name: "E", settings: posSettingsDefaults().sst_receipt, kind: "ORIGINAL" });
    const b = escposBytes(lines, { barcode: "T02-000279", copies: 1, cut: true });
    expect(Array.from(b.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(b.slice(-4))).toEqual([0x1d, 0x56, 0x42, 0x00]);
    const s = Array.from(b).map((x) => String.fromCharCode(x)).join("");
    expect(s).toContain("\x1dk\x49\x0c{BT02-000279");
    expect(escposBytes(lines, { barcode: null, copies: 2, cut: false }).length).toBeGreaterThan(b.length);
  });
});
