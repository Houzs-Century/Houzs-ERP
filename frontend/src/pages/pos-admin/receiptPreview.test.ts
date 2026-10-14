import { describe, expect, test } from "vitest";
import { posSettingsDefaults } from "../../vendor/shared/pos-settings";
import { SAMPLE_BILL, receiptColumns, receiptPreviewLines } from "./receiptPreview";

describe("receiptPreview", () => {
  test("58 mm is 32 columns, 80 mm is 48, and no line runs past the paper", () => {
    expect(receiptColumns(58)).toBe(32);
    expect(receiptColumns(80)).toBe(48);
    const s = posSettingsDefaults().sst_receipt;
    for (const w of [58, 80] as const) {
      const lines = receiptPreviewLines({ ...s, paper_width: w }, SAMPLE_BILL, false);
      expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(receiptColumns(w));
    }
  });

  test("SST prints 0.00 when unticked and the rate when ticked; FOC shows the price and takes nothing", () => {
    const s = posSettingsDefaults().sst_receipt;
    const off = receiptPreviewLines(s, SAMPLE_BILL, false);
    expect(off.find((l) => l.startsWith("SST 8%"))).toMatch(/0\.00$/);
    /* 2 x 59.90 + 159.00 = 278.80 gross, 11.98 off, FOC mug 0 */
    expect(off.find((l) => l.startsWith("Sub Total"))).toMatch(/278\.80$/);
    expect(off.find((l) => l.startsWith("FINAL TOTAL"))).toMatch(/266\.82$/);
    expect(off.some((l) => l.startsWith("  FOC"))).toBe(true);
    const on = receiptPreviewLines({ ...s, sst_reg_no: "W10-1808-32000123" }, SAMPLE_BILL, true);
    expect(on.find((l) => l.startsWith("SST 8%"))).toMatch(/21\.35$/);
    expect(on.find((l) => l.startsWith("FINAL TOTAL"))).toMatch(/288\.17$/);
    expect(on.some((l) => l.includes("SST No: W10-1808-32000123"))).toBe(true);
    expect(receiptPreviewLines({ ...s, show_sst_when_zero: false }, SAMPLE_BILL, false).some((l) => l.startsWith("SST"))).toBe(false);
  });

  test("header lines take the event name; salesman, cashier and barcode follow their toggles", () => {
    const s = { ...posSettingsDefaults().sst_receipt, header_lines: ["{event name}", "Booth A12", ""], show_cashier: false, print_receipt_barcode: false };
    const lines = receiptPreviewLines(s, SAMPLE_BILL, false);
    expect(lines.some((l) => l.includes("AEON Tebrau Cash & Carry"))).toBe(true);
    expect(lines.some((l) => l.includes("Booth A12"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Salesman Farah"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Cashier"))).toBe(false);
    expect(lines.some((l) => l.includes("|| T02-000279 ||"))).toBe(false);
  });
});
