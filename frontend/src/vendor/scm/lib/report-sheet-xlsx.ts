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
import { sheetWithTotalsBelow, type ReportSheet, type SheetColumn, type SheetRow, type SheetRowKind, type SheetTable } from './report-sheet';

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
  if (v === null) return { value: '-', type: String, align: col.align ?? 'right', color: SOFT, ...style };
  if (typeof v === 'string' || col.kind === 'text') return { value: String(v), type: String, ...(col.align ? { align: col.align } : {}), ...style };
  if (col.kind === 'pct') return { value: v / 100, type: Number, format: PCT_FORMAT, align: 'right', color: SOFT, ...style };
  return { value: v / 100, type: Number, format: AMOUNT_FORMAT, align: 'right', ...style };
};

/** One table row as Excel cells: the label indented by its depth, then a cell per column;
    a cell running across columns is merged over them, centred (the cells it covers stay
    empty, as write-excel-file asks). */
export const rowCells = (r: SheetRow, columns: SheetColumn[]): Row => {
  const style = kindStyle(r.kind);
  const label: Cell = { value: r.label, type: String, indent: r.depth, ...style };
  if (r.cells.length === 0) return [{ ...label, span: columns.length + 1 }];
  const covered = new Set<number>();
  columns.forEach((_, i) => { for (let k = 1; k < (r.spans?.[i] ?? 1); k += 1) covered.add(i + k); });
  return [label, ...columns.map((c, i): Cell => {
    if (covered.has(i)) return null;
    const cell = figure(c, r.cells[i] ?? null, style);
    const n = Math.min(r.spans?.[i] ?? 1, columns.length - i);
    return n > 1 ? { ...cell, span: n, align: 'center' } : cell;
  })];
};

const headerCell = (label: string, align: 'left' | 'center' | 'right'): Cell =>
  ({ value: label, type: String, fontWeight: 'bold', align, bottomBorderStyle: 'thin', bottomBorderColor: INK });

/** A table's header: one row of names; or, where columns share a heading (the Cash Flow's
    month over Settlement | Deposit), the headings merged over their columns on a first row
    and the columns' own names under them — a column without a heading stands both rows tall. */
export function headerRows(t: SheetTable): Row[] {
  const name = t.labelHeader ?? '';
  if (!t.columns.some((c) => c.group)) return [[headerCell(name, 'left'), ...t.columns.map((c) => headerCell(c.label, c.align ?? 'right'))]];
  const top: Row = [{ ...headerCell(name, 'left'), rowSpan: 2 }];
  const under: Row = [null];
  t.columns.forEach((c, i) => {
    if (!c.group) { top.push({ ...headerCell(c.label, c.align ?? 'right'), rowSpan: 2 }); under.push(null); return; }
    under.push(headerCell(c.label, c.align ?? 'right'));
    if (t.columns[i - 1]?.group === c.group) { top.push(null); return; }
    let n = 1;
    while (t.columns[i + n]?.group === c.group) n += 1;
    top.push({ ...headerCell(c.group, 'center'), ...(n > 1 ? { span: n } : {}) });
  });
  return [top, under];
}

/** How many rows the first table's header takes — what stays put under the title. */
export const headRowsOf = (sheet: ReportSheet): number => (sheet.tables[0]?.columns.some((c) => c.group) ? 2 : 1);

/** The whole sheet as write-excel-file's matrix — pure, so a test reads it without a workbook. */
export function sheetMatrix(given: ReportSheet): SheetData {
  const sheet = sheetWithTotalsBelow(given);
  const width = 1 + Math.max(1, ...sheet.tables.map((t) => t.columns.length));
  const rows: SheetData = [
    [{ value: sheet.title, type: String, fontWeight: 'bold', fontSize: 14, span: width }],
    [{ value: sheet.subtitle, type: String, color: SOFT, span: width }],
  ];
  sheet.tables.forEach((t) => {
    rows.push([]);
    if (t.title) rows.push([{ value: t.title, type: String, fontWeight: 'bold', fontSize: 12, span: width }]);
    rows.push(...headerRows(t));
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
  const out = [{ width: LABEL_WIDTH }, ...widest.map((c) => ({ width: c.kind === 'pct' ? PCT_WIDTH : AMOUNT_WIDTH }))];
  /* A column asked wider — by any of the tables sharing it — is that wide. */
  for (const t of sheet.tables) {
    t.columns.forEach((c, i) => { if (c.width != null) out[i + 1] = { width: Math.max(out[i + 1]?.width ?? AMOUNT_WIDTH, c.width) }; });
  }
  return out;
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
    stickyRowsCount: 3 + (sheet.tables[0]?.title ? 1 : 0) + headRowsOf(sheet),
    stickyColumnsCount: 1,
  });
}
