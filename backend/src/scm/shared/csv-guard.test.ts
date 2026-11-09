/* Regression: the emailed POS summary CSV wrote till-typed text (salesman,
   item description, void reason) as-is, so "=HYPERLINK(...)" ran as a formula
   in the manager's Excel. Text cells now get the OWASP single-quote prefix;
   amounts, negative ones included, stay numeric. */
import { describe, expect, test } from "vitest";
import { guardFormula, unguardFormula } from "./csv-guard";
import { aggregateSales, summaryCsv, type ReportSale } from "./pos-report";

describe("guardFormula", () => {
  test("formula starters become text", () => {
    for (const s of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1:A9)", "\t=1", "\r=1", "-"]) {
      expect(guardFormula(s), JSON.stringify(s)).toBe(`'${s}`);
    }
  });

  test("plain numbers, negatives included, are left alone", () => {
    for (const n of ["-12.50", "-0.5", "-.5", "+3", "-1,234.50", "-1000", "12.50", "0"]) {
      expect(guardFormula(n), n).toBe(n);
    }
  });

  test("ordinary text is untouched and the inverse round-trips", () => {
    expect(guardFormula("Pillow 2-pack")).toBe("Pillow 2-pack");
    for (const s of ["=1+1", "-", "@home", "'already quoted", "-5", "Mug"]) {
      expect(unguardFormula(guardFormula(s))).toBe(s);
    }
  });
});

describe("summaryCsv", () => {
  const sale = (over: Partial<ReportSale>): ReportSale => ({
    uuid: "u", type: "SALE", status: "PAID", receipt_no: "T02-000001", terminal_code: "T02", sold_at: "2026-10-14T06:00:00Z",
    cashier_name: "Aina", salesman_name: "=HYPERLINK(\"http://x\",\"click\")",
    subtotal_sen: 5990, item_discount_sen: 0, bill_discount_sen: 0, sst_amount_sen: 0, total_sen: 5990, is_test: false,
    lines: [{ item_code: "PL-01", description: "@SUM(A1:A9)", qty: 1, unit_price_sen: 5990, discount_amount_sen: 0, is_foc: false, amount_sen: 5990 }],
    payments: [{ method: "QR", amount_sen: 5990 }], ...over,
  });

  test("till-typed text is neutralised; a negative amount stays a number", () => {
    const csv = summaryCsv("Fair", aggregateSales([
      sale({}),
      sale({ uuid: "r", type: "RETURN", receipt_no: "R-T02-000002", total_sen: -5990, subtotal_sen: -5990,
        lines: [{ item_code: "PL-01", description: "@SUM(A1:A9)", qty: -1, unit_price_sen: 5990, discount_amount_sen: 0, is_foc: false, amount_sen: -5990 }],
        payments: [{ method: "QR", amount_sen: -5990 }] }),
    ]));
    const cells = csv.split("\r\n").flatMap((l) => l.split(","));
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(csv).toContain(`"'=HYPERLINK(""http://x""`);
    expect(cells).toContain("'@SUM(A1:A9)");
    expect(cells).toContain("-59.90");
    expect(cells.some((c) => c.startsWith("'-") && /\d/.test(c))).toBe(false);
  });
});
