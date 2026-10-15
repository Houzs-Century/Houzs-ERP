import { describe, expect, test } from "vitest";
import { aggregateSales } from "../../vendor/shared/pos-report";
import { reportXlsxRows } from "./PosReportTab";

describe("Sales Report export rows", () => {
  test("the item block gains a stock-left column from the balances map", () => {
    const t = aggregateSales([{
      uuid: "u", type: "SALE", status: "PAID", receipt_no: "T02-000001", terminal_code: "T02", sold_at: "2026-10-14T06:00:00Z", cashier_name: "Aina", salesman_name: "Farah",
      subtotal_sen: 5990, item_discount_sen: 0, bill_discount_sen: 0, sst_amount_sen: 0, total_sen: 5990, is_test: false,
      lines: [{ item_code: "PL-01", description: "Pillow", qty: 1, unit_price_sen: 5990, discount_amount_sen: 0, is_foc: false, amount_sen: 5990 }],
      payments: [{ method: "QR", amount_sen: 5990 }],
    }]);
    const rows = reportXlsxRows("AEON", t, { "PL-01": 12 });
    const head = rows.find((r) => r[0] === "By item");
    expect(head).toEqual(["By item", "Description", "Qty", "FOC", "Gross (RM)", "Discount (RM)", "Net (RM)", "Stock left"]);
    expect(rows[rows.indexOf(head!) + 1]).toEqual(["PL-01", "Pillow", 1, 0, "59.90", "0.00", "59.90", 12]);
  });
});
