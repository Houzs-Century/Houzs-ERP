import { describe, expect, test } from "vitest";
import { aggregateSales, summaryCsv, summaryHtml, type ReportSale } from "./pos-report";

const sale = (over: Partial<ReportSale>): ReportSale => ({
  uuid: "u", type: "SALE", status: "PAID", receipt_no: "T02-000001", terminal_code: "T02", sold_at: "2026-10-14T06:00:00Z", cashier_name: "Aina", salesman_name: "Farah",
  subtotal_sen: 11980, item_discount_sen: 1198, bill_discount_sen: 0, sst_amount_sen: 0, total_sen: 10782, is_test: false,
  lines: [{ item_code: "PL-01", description: "Pillow", qty: 2, unit_price_sen: 5990, discount_amount_sen: 1198, is_foc: false, amount_sen: 10782 }, { item_code: "GF-01", description: "Mug", qty: 1, unit_price_sen: 1500, discount_amount_sen: 1500, is_foc: true, amount_sen: 0 }],
  payments: [{ method: "QR", amount_sen: 10782 }], ...over,
});

describe("aggregateSales", () => {
  test("counts bills, nets returns, excludes void and test, splits by method / salesman / day / terminal / item", () => {
    const t = aggregateSales([
      sale({}),
      sale({ uuid: "r", type: "RETURN", receipt_no: "R-T02-000002", total_sen: -5391, subtotal_sen: -5990, item_discount_sen: -599, lines: [{ item_code: "PL-01", description: "Pillow", qty: -1, unit_price_sen: 5990, discount_amount_sen: -599, is_foc: false, amount_sen: -5391 }], payments: [{ method: "QR", amount_sen: -5391 }], sold_at: "2026-10-15T06:00:00Z" }),
      sale({ uuid: "v", status: "VOID", receipt_no: "T02-000003" }),
      sale({ uuid: "x", is_test: true }),
      sale({ uuid: "b", terminal_code: "T01", salesman_name: null, payments: [{ method: "CREDIT", amount_sen: 10782 }], sold_at: "2026-10-15T08:00:00Z" }),
    ]);
    expect(t.bills).toBe(2);
    expect(t.net_sen).toBe(10782 * 2 - 5391);
    expect(t.gross_sen).toBe(23960);
    expect(t.discount_sen).toBe(2396);
    expect(t.void_count).toBe(1);
    expect(t.void_sen).toBe(10782);
    expect(t.return_count).toBe(1);
    expect(t.return_sen).toBe(5391);
    expect(t.foc_units).toBe(2);
    expect(t.by_method).toEqual([{ method: "CREDIT", amount_sen: 10782, sales_sen: 10782, refund_sen: 0 }, { method: "QR", amount_sen: 5391, sales_sen: 10782, refund_sen: 5391 }]);
    expect(t.voids).toEqual([{ receipt_no: "T02-000003", total_sen: 10782, reason: "", by: "Aina" }]);
    expect(t.returns).toEqual([{ receipt_no: "R-T02-000002", total_sen: -5391, ref: "" }]);
    expect(t.by_salesman).toEqual([{ salesman: "Booth", bills: 1, net_sen: 10782 }, { salesman: "Farah", bills: 1, net_sen: 5391 }]);
    expect(t.by_day.map((d) => [d.day, d.bills, d.net_sen])).toEqual([["2026-10-14", 1, 10782], ["2026-10-15", 1, 5391]]);
    expect(t.by_terminal).toEqual([{ terminal: "T01", bills: 1, net_sen: 10782 }, { terminal: "T02", bills: 1, net_sen: 5391 }]);
    expect(t.by_item[0]).toEqual({ item_code: "PL-01", description: "Pillow", qty: 3, foc_qty: 0, gross_sen: 17970, discount_sen: 1797, net_sen: 16173 });
    expect(t.by_item.find((i) => i.item_code === "GF-01")).toMatchObject({ qty: 0, foc_qty: 2, net_sen: 0 });
    expect(t.top_items[0]!.item_code).toBe("PL-01");
  });
  test("the CSV and the HTML carry the figures", () => {
    const t = aggregateSales([sale({})]);
    const csv = summaryCsv("AEON C&C", t);
    expect(csv).toContain("Net sales (RM),107.82");
    expect(csv).toContain("QR,107.82,0.00,107.82");
    expect(csv).toContain("PL-01,Pillow,2,0,119.80,11.98,107.82");
    const html = summaryHtml("AEON <C&C>", t);
    expect(html).toContain("AEON &lt;C&amp;C&gt;");
    expect(html).toContain("RM 107.82");
  });
});
