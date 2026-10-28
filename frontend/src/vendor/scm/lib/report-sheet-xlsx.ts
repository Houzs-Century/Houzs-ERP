// ----------------------------------------------------------------------------
// report-sheet-xlsx — a Finance report's sheet as an Excel workbook that reads
// like the screen (owner 2026-09-19: excel 那边也要优化 … 就应该和原本的一样): the
// title and the period on top, the same columns, a block title bold, a
// category bold, an account row indented by its depth, an unassigned row
// italic, a total row shaded, a subtotal (net) row shaded darker with a rule
// above — the screen's own shades. Amounts are NUMBERS in the cell with the
// bracketed-negative format, so a sum in Excel still adds; a % is a number
// with the % format; a dash stays a dash. The header row and the name
// column stay put while the sheet scrolls, as on the screen.
// `write-excel-file` is loaded lazily so it never touches the first bundle.
// ----------------------------------------------------------------------------

import type { Cell, Row, SheetData } from 'write-excel-file';
import type { ReportSheet, SheetColumn, SheetRow, SheetRowKind } from './report-sheet';

/* The screen's own colours (tokens.css): ink, soft text, the two shades. */
const INK = '#11140f';
const SOFT = '#8a8578';
const TOTAL_FILL = '#eceeea';
const NET_FILL = '#e3e6e0';
const RULE = '#c9c7c0';

/** 1,234.56 — a negative in parentheses, as every Finance report reads it. */
export const AMOUNT_FORMAT = '#,##0.00;(#,##0.00)';
export const PCT_FORMAT = '0.0%';

const LABEL_WIDTH = 46;
const AMOUNT_WIDTH = 14;
const PCT_WIDTH = 9;

/** How a row of each kind dresses every one of its cells. */
export const kindStyle = (kind: SheetRowKind): Partial<Cell & object> => {
  switch (kind) {
    case 'block': return { fontWeight: 'bold', fontSize: 11 };
    case 'category': return { fontWeight: 'bold' };
    case 'unassigned': return { fontStyle: 'italic', color: SOFT };
    case 'total': return { fontWeight: 'bold', backgroundColor: TOTAL_FILL, topBorderStyle: 'thin', topBorderColor: RULE };
    case 'net': return { fontWeight: 'bold', backgroundColor: NET_FILL, topBorderStyle: 'medium', topBorderColor: INK };
    default: return {};
  }
};

const figure = (col: SheetColumn, v: number | string | null, style: object): Cell => {
  if (v === null) return { value: '-', type: String, align: 'right', color: SOFT, ...style };
  if (typeof v === 'string' || col.kind === 'text') return { value: String(v), type: String, ...style };
  if (col.kind === 'pct') return { value: v / 100, type: Number, format: PCT_FORMAT, align: 'right', color: SOFT, ...style };
  return { value: v / 100, type: Number, format: AMOUNT_FORMAT, align: 'right', ...style };
};

/** One table row as Excel cells: the label indented by its depth, then a cell per column. */
export const rowCells = (r: SheetRow, columns: SheetColumn[]): Row => {
  const style = kindStyle(r.kind);
  const label: Cell = { value: r.label, type: String, indent: r.depth, ...style };
  if (r.cells.length === 0) return [{ ...label, span: columns.length + 1 }];
  return [label, ...columns.map((c, i) => figure(c, r.cells[i] ?? null, style))];
};

const headerCell = (label: string, align: 'left' | 'right'): Cell =>
  ({ value: label, type: String, fontWeight: 'bold', align, bottomBorderStyle: 'thin', bottomBorderColor: INK });

/** The whole sheet as write-excel-file's matrix — pure, so a test reads it without a workbook. */
export function sheetMatrix(sheet: ReportSheet): SheetData {
  const width = 1 + Math.max(1, ...sheet.tables.map((t) => t.columns.length));
  const rows: SheetData = [
    [{ value: sheet.title, type: String, fontWeight: 'bold', fontSize: 14, span: width }],
    [{ value: sheet.subtitle, type: String, color: SOFT, span: width }],
  ];
  sheet.tables.forEach((t) => {
    rows.push([]);
    rows.push([headerCell('', 'left'), ...t.columns.map((c) => headerCell(c.label, 'right'))]);
    for (const r of t.rows) rows.push(rowCells(r, t.columns));
  });
  if (sheet.notes && sheet.notes.length > 0) {
    rows.push([]);
    for (const n of sheet.notes) rows.push([{ value: n, type: String, color: SOFT, span: width }]);
  }
  return rows;
}

/** The column widths: the name column wide, an amount column, a % column narrower. */
export const columnWidths = (sheet: ReportSheet): Array<{ width: number }> => {
  const widest = sheet.tables.reduce((best, t) => (t.columns.length > best.length ? t.columns : best), [] as SheetColumn[]);
  return [{ width: LABEL_WIDTH }, ...widest.map((c) => ({ width: c.kind === 'pct' ? PCT_WIDTH : AMOUNT_WIDTH }))];
};

/** Excel forbids / \ ? * [ ] : in a sheet's name and more than 31 characters. */
export const sheetName = (title: string): string => title.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim() || 'Report';

/** Write the sheet and hand it to the browser as a download. */
export async function downloadReportXlsx(sheet: ReportSheet, fileName: string): Promise<void> {
  const writeXlsxFile = (await import('write-excel-file')).default;
  await writeXlsxFile(sheetMatrix(sheet), {
    fileName,
    sheet: sheetName(sheet.title),
    columns: columnWidths(sheet),
    /* The title, the subtitle, a blank and the first table's header stay put; so does the name column. */
    stickyRowsCount: 4,
    stickyColumnsCount: 1,
  });
}
