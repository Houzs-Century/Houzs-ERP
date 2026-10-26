// ----------------------------------------------------------------------------
// stock-take-xlsx — the Count Sheet as an Excel workbook (2990-0014, Sim:
// "need export to excel format also", next to Print PDF). The screen's columns
// in the screen's order; quantities and RM are numbers in the cell, so a sum
// in Excel still adds. SERVER rows, like the PDF: a typed-but-unsaved count is
// not on the record. When the server withheld every system qty (blind take,
// non-supervising viewer) System / Variance / Value are left out, decided from
// the data as the PDF does. `write-excel-file` is loaded lazily.
// ----------------------------------------------------------------------------

import type { Cell, SheetData } from 'write-excel-file';
import type { StockTakeLine } from './stock-queries';
import { AMOUNT_FORMAT, sheetName } from './report-sheet-xlsx';
import { fmtStockSources } from './stock-take-sources';

export type StockTakeXlsxHeader = {
  takeNo: string;
  /* One line under the title: warehouse · date · scope · status · assignees. */
  subtitle: string;
};

export type StockTakeXlsxNames = {
  rackOf: (rackId: string | null) => string;
  staffOf: (staffId: string) => string;
};

type Col = { label: string; width: number; num?: boolean; cell: (l: StockTakeLine) => Cell };

const SOFT = '#8a8578';
const INK = '#11140f';

const text = (v: string | null | undefined): Cell => (v ? { value: v, type: String } : null);
const qty = (v: number | null | undefined): Cell => (v == null ? null : { value: v, type: Number, align: 'right' });

/* counted − system, as the screen works it out: the stored `variance` column
   came back null on prod for counted lines (HC-STK-2610-005). An UNCOUNTED
   line has no variance — a 0 there would say the count agreed. */
const varianceOf = (l: StockTakeLine): number | null =>
  l.counted_qty == null || l.system_qty == null ? null : l.counted_qty - l.system_qty;

export const systemQtyWithheld = (lines: StockTakeLine[]): boolean =>
  lines.length > 0 && lines.every((l) => l.system_qty == null);

export function stockTakeColumns(lines: StockTakeLine[], names: StockTakeXlsxNames): Col[] {
  const withheld = systemQtyWithheld(lines);
  const cols: Array<Col | false> = [
    { label: 'SKU', width: 26, cell: (l) => text(l.item_code) },
    { label: 'Name', width: 34, cell: (l) => text(l.product_name) },
    { label: 'Variant', width: 40, cell: (l) => text(l.variant_label) },
    !withheld && { label: 'PO', width: 30, cell: (l) => text(fmtStockSources(l.stock_sources)) },
    !withheld && { label: 'System Qty', width: 11, num: true, cell: (l) => qty(l.system_qty) },
    { label: 'Counted Qty', width: 12, num: true, cell: (l) => qty(l.counted_qty) },
    { label: 'Rack', width: 12, cell: (l) => text(l.rack_id ? names.rackOf(l.rack_id) : null) },
    { label: 'Notes', width: 28, cell: (l) => text(l.notes) },
    !withheld && { label: 'Variance', width: 10, num: true, cell: (l) => qty(varianceOf(l)) },
    !withheld && {
      label: 'Value (RM)', width: 13, num: true,
      cell: (l) => {
        const v = varianceOf(l);
        if (v == null || v === 0 || l.est_unit_cost_sen == null) return null;
        return { value: (v * l.est_unit_cost_sen) / 100, type: Number, format: AMOUNT_FORMAT, align: 'right' };
      },
    },
    { label: 'Counted By', width: 18, cell: (l) => text(l.counted_by ? names.staffOf(l.counted_by) : null) },
  ];
  return cols.filter((c): c is Col => c !== false);
}

/** The whole sheet as write-excel-file's matrix — pure, so a test reads it without a workbook. */
export function stockTakeMatrix(header: StockTakeXlsxHeader, lines: StockTakeLine[], cols: Col[]): SheetData {
  return [
    [{ value: header.takeNo, type: String, fontWeight: 'bold', fontSize: 14, span: cols.length }],
    [{ value: header.subtitle, type: String, color: SOFT, span: cols.length }],
    [],
    cols.map((c) => ({
      value: c.label, type: String, fontWeight: 'bold', align: c.num ? 'right' : 'left',
      bottomBorderStyle: 'thin', bottomBorderColor: INK,
    })),
    ...lines.map((l) => cols.map((c) => c.cell(l))),
  ];
}

export async function downloadStockTakeXlsx(header: StockTakeXlsxHeader, lines: StockTakeLine[], names: StockTakeXlsxNames): Promise<void> {
  const cols = stockTakeColumns(lines, names);
  const writeXlsxFile = (await import('write-excel-file')).default;
  await writeXlsxFile(stockTakeMatrix(header, lines, cols), {
    fileName: `${header.takeNo}.xlsx`,
    sheet: sheetName(header.takeNo),
    columns: cols.map((c) => ({ width: c.width })),
    /* Title, subtitle, a blank and the column header stay put; so does the SKU. */
    stickyRowsCount: 4,
    stickyColumnsCount: 1,
  });
}
