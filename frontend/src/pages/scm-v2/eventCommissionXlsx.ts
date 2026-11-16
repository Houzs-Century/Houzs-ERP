// ----------------------------------------------------------------------------
// eventCommissionXlsx — Event Commission's workbook, from eventCommissionExport
// (owner 2026-11-16: 导出的效果不满意 — 排版): a sheet per table, so each table
// keeps its own columns and widths (on one sheet the tables shared one set of
// widths and the first table's frozen header). On each sheet: its title, then
// the period, view, brand and who; the header bold over a rule, frozen with
// those two lines; money a number in Finance's bracketed format, a day a real
// date, a count a number; a salesperson's name bold over their lines, their
// subtotal shaded, the total shaded darker over a rule. write-excel-file loads
// on the press.
// ----------------------------------------------------------------------------

import type { Cell, Columns, SheetData } from 'write-excel-file';
import { excelDaySerial, type ExportCell } from '../../components/dataTableLineExport';
import { AMOUNT_FORMAT, sheetName } from '../../vendor/scm/lib/report-sheet-xlsx';
import type { EcColumn, EcRowKind, EcSheet } from './eventCommissionExport';

const INK = '#11140f';
const SOFT = '#8a8578';
const SUBTOTAL_FILL = '#f1f2ee';
const TOTAL_FILL = '#e3e6e0';
const DATE_FORMAT = 'yyyy/mm/dd';
/** The title, the line under it and the header stay put on every sheet. */
export const EC_STICKY_ROWS = 3;

type Style = Partial<Cell & object>;
const styleOf = (kind: EcRowKind): Style => {
  switch (kind) {
    case 'memo': return { color: SOFT };
    case 'group': return { fontWeight: 'bold' };
    case 'subtotal': return { fontWeight: 'bold', backgroundColor: SUBTOTAL_FILL };
    case 'total': return { fontWeight: 'bold', backgroundColor: TOTAL_FILL, topBorderStyle: 'thin', topBorderColor: INK };
    default: return {};
  }
};

/** One cell: money a number in the bracketed format, a day a date, a count a number, words as they are. */
export function ecCell(col: EcColumn, v: ExportCell, style: Style, indent = 0): Cell {
  if (v == null || v === '') return { type: String, value: '', ...style };
  if (typeof v === 'number' && col.format === 'money') return { type: Number, value: v, format: AMOUNT_FORMAT, align: 'right', ...style };
  if (typeof v === 'number' && col.format === 'number') return { type: Number, value: v, align: 'right', ...style };
  if (col.format === 'date') {
    const serial = excelDaySerial(String(v).replace(/\//g, '-'));
    if (serial != null) return { type: Number, value: serial, format: DATE_FORMAT, align: 'left', ...style };
  }
  return { type: String, value: String(v), align: col.align, ...(indent > 0 ? { indent } : {}), ...style };
}

/** What a cell shows, for its column's width. */
const shownText = (c: EcColumn, v: ExportCell): string => {
  if (v == null) return '';
  if (typeof v === 'number' && c.format === 'money') return `(${Math.abs(v).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
  if (c.format === 'date') return '0000/00/00';
  return String(v);
};

/** Each column as wide as the longest thing in it. A long heading wraps instead; a
    salesperson's name and the foot labels run on into the empty cells beside them. */
export function ecColumnWidths(sheet: EcSheet): Columns {
  const n = Math.max(1, ...sheet.blocks.map((b) => b.columns.length));
  return Array.from({ length: n }, (_, i) => {
    let w = 6;
    for (const b of sheet.blocks) {
      const c = b.columns.at(i);
      if (!c) continue;
      w = Math.max(w, Math.min(c.label.length, 14));
      for (const row of b.rows) if (row.kind === 'row' || row.kind === 'memo') w = Math.max(w, shownText(c, row.cells[i] ?? null).length + (row.kind === 'memo' ? 2 : 0));
    }
    return { width: Math.min(48, w + 2) };
  });
}

/** One sheet as write-excel-file's matrix — pure, so a test reads it without a workbook. */
export function ecSheetData(sheet: EcSheet): SheetData {
  const data: SheetData = [
    [{ type: String, value: sheet.title, fontWeight: 'bold', fontSize: 13 }],
    [{ type: String, value: sheet.subtitle, color: SOFT }],
  ];
  sheet.blocks.forEach((b, i) => {
    if (i > 0) data.push([]);
    if (b.title) data.push([{ type: String, value: b.title, fontWeight: 'bold', fontSize: 11 }]);
    if (b.note) data.push([{ type: String, value: b.note, color: SOFT }]);
    data.push(b.columns.map((c): Cell => ({
      type: String, value: c.label, fontWeight: 'bold', align: c.align, alignVertical: 'bottom', wrap: true, bottomBorderStyle: 'thin', bottomBorderColor: INK,
    })));
    for (const row of b.rows) {
      const style = styleOf(row.kind);
      data.push(b.columns.map((c, ci) => ecCell(c, row.cells[ci] ?? null, style, row.kind === 'memo' && ci === 0 ? 1 : 0)));
    }
  });
  for (const note of sheet.notes) {
    data.push([]);
    data.push([{ type: String, value: note, color: SOFT }]);
  }
  return data;
}

/** Excel's tab names: no / \ ? * [ ] :, at most 31 characters, each once. */
export function ecSheetNames(sheets: readonly EcSheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s) => {
    const base = sheetName(s.name);
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k += 1) name = `${base.slice(0, 27).trim()} (${k})`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** Write the workbook and hand it to the browser as a download. */
export async function downloadEcXlsx(sheets: readonly EcSheet[], fileName: string): Promise<void> {
  const writeXlsxFile = (await import('write-excel-file')).default;
  await writeXlsxFile(sheets.map(ecSheetData), {
    fileName,
    sheets: ecSheetNames(sheets),
    columns: sheets.map(ecColumnWidths),
    stickyRowsCount: EC_STICKY_ROWS,
    fontSize: 10,
  });
}
