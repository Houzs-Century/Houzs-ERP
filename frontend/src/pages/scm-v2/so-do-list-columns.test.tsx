/* The Sales Order and Delivery Order grids' export cells: one row per line,
 * money in RINGGIT (never sen), dates as dates, and no money on a delivery
 * order line (owner 2026-09-15). The file is built by the same DataTable
 * function the Export button runs (buildLineExportMatrix). */
import { describe, expect, test, vi } from "vitest";
import { buildLineExportMatrix } from "../../components/dataTableLineExport";
import { doLineColumns, financeColumns, moneyColumn, soLineColumns } from "./so-do-list-columns";
import { SO_LABELS, type SoListLine } from "../../vendor/scm/lib/so-line-export-columns";
import { DO_LABELS, type DoListLine } from "../../vendor/scm/lib/do-line-export-columns";

vi.mock("../../vendor/scm/lib/authed-fetch", () => ({ authedFetch: vi.fn() }));
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { fetchDoExportRows, fetchSoExportRows } from "../../vendor/scm/lib/so-list-export";

const soLine = (over: Partial<SoListLine> = {}): SoListLine => ({
  id: "l-1", line_no: 1, item_code: "DSL-9028 SOFA", erp_item_code: "9028-1S", description: "DSL SOFA - 9028",
  description2: "EZ-002 Sand / SEAT 28", item_group: "SOFA", uom: "SET", location: "KL", qty: 2,
  unit_price_sen: 123456.5, discount_sen: 1050, total_sen: 245863, delivery_date: "2026-09-30", remark: null,
  stock_status: null, delivered_qty: 1, returned_qty: 0, remaining_qty: 1, on_delivery_order_qty: 0,
  do_nos: [], po_nos: ["HC-PO-1"], po_delivery_date: null, ...over,
});

type SoRowT = { doc_no: string; local_total_sen: number; bedframe_sen?: number; lines?: SoListLine[] };

describe("no sen in the Sales Order file", () => {
  test("a line's unit price, discount and total, and the order's total and category amounts, are ringgit", () => {
    const lineCols = soLineColumns<SoRowT>();
    const cols = [
      moneyColumn<SoRowT, SoListLine>({ key: "amount", label: SO_LABELS.total, sen: (r) => r.local_total_sen }),
      ...financeColumns<SoRowT, SoListLine>("Finance").filter((c) => c.key === "bedframe_sen"),
      lineCols.unit_price!, lineCols.discount!, lineCols.line_total!, lineCols.qty!, lineCols.item_code!,
    ];
    const row: SoRowT = { doc_no: "HC-SO-1", local_total_sen: 1500000, bedframe_sen: 99999, lines: [soLine(), soLine({ id: "l-2", qty: 1, total_sen: 5000 })] };
    const m = buildLineExportMatrix([row], (r) => r.lines ?? [], cols);
    expect(m.header).toEqual([SO_LABELS.total, "Bedframe", SO_LABELS.unitPrice, SO_LABELS.discount, SO_LABELS.lineTotal, SO_LABELS.qty, SO_LABELS.itemCode]);
    expect(m.formats).toEqual(["money", "money", "rate", "money", "money", "number", "text"]);
    expect(m.body).toEqual([
      [15000, 999.99, 1234.565, 10.5, 2458.63, 2, "DSL-9028 SOFA"],
      [15000, 999.99, 1234.565, 10.5, 50, 1, "DSL-9028 SOFA"],
    ]);
    for (const cell of m.body.flat()) expect([1500000, 99999, 123456.5, 1050, 245863, 5000]).not.toContain(cell);
  });

  test("a line date exports as a date cell", () => {
    const col = soLineColumns<SoRowT>().po_delivery_date!;
    expect(col.exportFormat).toBe("date");
    const m = buildLineExportMatrix([{ doc_no: "X", local_total_sen: 0, lines: [soLine({ po_delivery_date: "2026-10-01" })] }], (r) => r.lines ?? [], [col]);
    expect(m.body).toEqual([["2026-10-01"]]);
  });
});

describe("the grid opens with AutoCount's columns", () => {
  test("the SO line columns in SALES ORDER DETAILS-SALES are visible; the ERP-only ones are hidden", () => {
    const cols = soLineColumns<SoRowT>();
    const shown = Object.values(cols).filter((c) => !c.defaultHidden).map((c) => c.label);
    expect(shown.sort()).toEqual([SO_LABELS.itemGroup, SO_LABELS.itemCode, SO_LABELS.detailDescription, SO_LABELS.detailDescription2, SO_LABELS.uom, SO_LABELS.unitPrice, SO_LABELS.qty, SO_LABELS.location].sort());
  });

  test("the DO line columns carry no money, and every finance column is hidden", () => {
    const cols = doLineColumns<{ lines?: DoListLine[] }>();
    expect(Object.values(cols).filter((c) => /price|total|amount|discount/i.test(c.label))).toEqual([]);
    expect(Object.values(cols).filter((c) => c.exportFormat === "money" || c.exportFormat === "rate")).toEqual([]);
    expect(Object.values(cols).filter((c) => !c.defaultHidden).map((c) => c.label).sort()).toEqual(
      [DO_LABELS.itemCode, DO_LABELS.detailDescription, DO_LABELS.detailDescription2, DO_LABELS.uom, DO_LABELS.location, DO_LABELS.qty, DO_LABELS.poDocNo, DO_LABELS.itemGroup].sort(),
    );
    expect(financeColumns<Record<string, number>, DoListLine>(undefined).every((c) => c.defaultHidden)).toBe(true);
  });
});

describe("the export reads every window of the list's filter, or refuses", () => {
  test("sends the list's own parameters, follows next until there is none, and drops a repeat", async () => {
    const mockedFetch = vi.mocked(authedFetch);
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValueOnce({ salesOrders: [{ doc_no: "A" }, { doc_no: "B" }], total: 2, lineCount: 0, next: 2 });
    mockedFetch.mockResolvedValueOnce({ salesOrders: [{ doc_no: "B" }, { doc_no: "C" }], total: 2, lineCount: 0, next: null });
    expect(await fetchSoExportRows({ status: "confirmed", q: " bob ", sort: "so_date:desc" })).toEqual([{ doc_no: "A" }, { doc_no: "B" }, { doc_no: "C" }]);
    expect(mockedFetch.mock.calls.map((c) => c[0])).toEqual([
      "/mfg-sales-orders/export/rows?status=CONFIRMED&q=bob&sort=so_date%3Adesc&offset=0",
      "/mfg-sales-orders/export/rows?status=CONFIRMED&q=bob&sort=so_date%3Adesc&offset=2",
    ]);
  });

  test("refuses a listing larger than one export holds, and a server that does not move forward", async () => {
    const mockedFetch = vi.mocked(authedFetch);
    mockedFetch.mockReset();
    const big = Array.from({ length: 20_000 }, (_, i) => ({ id: `d-${i}` }));
    mockedFetch.mockResolvedValueOnce({ deliveryOrders: big, total: 20_000, lineCount: 0, next: 20_000 });
    await expect(fetchDoExportRows({ status: "DELIVERED" })).rejects.toThrow(/no file was written/);
    expect(mockedFetch.mock.calls[0]![0]).toBe("/delivery-orders-mfg/export/rows?status=DELIVERED&offset=0");
    mockedFetch.mockResolvedValueOnce({ salesOrders: [{ doc_no: "A" }], total: 1, lineCount: 0, next: 0 });
    await expect(fetchSoExportRows({})).rejects.toThrow(/out of order/);
  });
});
