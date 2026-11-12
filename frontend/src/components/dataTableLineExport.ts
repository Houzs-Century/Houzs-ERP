/* DataTable's line export — one spreadsheet row per document LINE, with the
 * grid's visible columns (owner 2026-09-15: "exactly like AutoCount … the
 * columns I show get exported, the columns I hide do not").
 *
 * A column says how it exports:
 *   lineValue(row, line)  the cell for ONE line. A document with no lines still
 *                         gets one row, and this cell is blank on it.
 *   exportValue(row)      a document-level value for the file (money in ringgit
 *                         where getValue holds sen for sorting). Repeats per line.
 *   getValue(row)         otherwise, the grid's own value. Repeats per line.
 *   exportFormat          the Excel cell type: date = a real date cell shown
 *                         yyyy/mm/dd (AutoCount's listing format), money = number
 *                         #,##0.00, rate = number with up to 4 decimals (a unit
 *                         price), number = a plain number, text = as is.
 *
 * The rows reaching here have already been through the grid's funnel filter
 * and sort (dataTableRows.ts), so the file follows the view. */

import { isoForExport, type CSVColumn } from "../lib/csv";

export type ExportCell = string | number | null;
export type ExportFormat = "text" | "number" | "money" | "rate" | "date";

export type LineExportColumn<T, L> = {
  key: string;
  label: string;
  /** The exported header when it must differ from the on-screen label. */
  exportLabel?: string;
  getValue?: (row: T) => string | number | boolean | null | undefined;
  exportValue?: (row: T) => ExportCell;
  lineValue?(row: T, line: L): ExportCell;
  exportFormat?: ExportFormat;
};

/** What a page gives DataTable to export by line. */
export type DataTableLineExport<T, L> = {
  /**
   * EVERY row the list's SERVER filter matches (tab, search, sort — all pages),
   * in the list's row shape, each carrying its lines. `exportKeys` are the
   * columns the file will hold and `filterKeys` the columns with an active
   * funnel, so a page fetches derived data (MRP enrichment) only when one of
   * them needs it. THROW to refuse — e.g. the server stopped reading
   * (`truncated`); a short file that looks complete is the defect this replaces.
   */
  fetchRows: (need: { exportKeys: string[]; filterKeys: string[] }) => Promise<T[]>;
  linesOf: (row: T) => readonly L[];
  sheetName: string;
  /** Required: a failed export must reach the operator (CLAUDE.md R62). */
  onError: (e: Error) => void;
};

export type LineExportMatrix = { header: string[]; formats: ExportFormat[]; body: ExportCell[][] };

const cellOf = (v: string | number | boolean | null | undefined): ExportCell => {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = isoForExport(v);
  return typeof s === "number" ? s : s === "" ? null : s;
};

export function exportableColumns<T, L>(columns: readonly LineExportColumn<T, L>[]): LineExportColumn<T, L>[] {
  return columns.filter((c) => c.getValue || c.exportValue || c.lineValue);
}

export function buildLineExportMatrix<T, L>(
  rows: readonly T[],
  linesOf: (row: T) => readonly L[],
  columns: readonly LineExportColumn<T, L>[],
): LineExportMatrix {
  const cols = exportableColumns(columns);
  const docCell = (c: LineExportColumn<T, L>, row: T): ExportCell =>
    c.exportValue ? c.exportValue(row) : cellOf(c.getValue?.(row));
  const body: ExportCell[][] = [];
  for (const row of rows) {
    const lines = linesOf(row);
    const doc = cols.map((c) => (c.lineValue ? null : docCell(c, row)));
    if (lines.length === 0) {
      body.push(doc);
      continue;
    }
    for (const line of lines) {
      body.push(cols.map((c, i) => (c.lineValue ? cellOf(c.lineValue(row, line)) : doc[i]!)));
    }
  }
  return {
    header: cols.map((c) => c.exportLabel || c.label || c.key),
    formats: cols.map((c) => c.exportFormat ?? "text"),
    body,
  };
}

/** The visible columns as the CSV export reads them. */
export function csvColumnsOf<T, L>(columns: readonly LineExportColumn<T, L>[]): CSVColumn<T>[] {
  return columns
    .filter((c) => typeof c.getValue === "function" || typeof c.exportValue === "function")
    .map((c) => ({
      key: c.key,
      label: c.exportLabel || c.label || c.key,
      getValue: (r: T) => (c.exportValue ? c.exportValue(r) : isoForExport(c.getValue!(r) as string | number | null)),
    }));
}

/** What a table hands its PDF (`onExportPdf`): the cells its Excel would hold, each
 *  column's key, and the rows behind them. */
export type TablePdfView<T> = { keys: string[]; matrix: LineExportMatrix; rows: readonly T[] };

export function tablePdfViewOf<T, L>(rows: readonly T[], columns: readonly LineExportColumn<T, L>[]): TablePdfView<T> {
  const cols = exportableColumns(columns);
  return { keys: cols.map((c) => c.key), matrix: buildLineExportMatrix(rows, () => [], cols), rows };
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
/** yyyy-mm-dd -> the Excel day serial, timezone-free (a JS Date cell would be
 *  shifted by the browser's offset). */
export function excelDaySerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : (t - EXCEL_EPOCH_MS) / 86_400_000;
}

const NUMBER_FORMAT: Record<ExportFormat, string | null> = {
  text: null,
  number: "General",
  money: "#,##0.00",
  rate: "#,##0.00##",
  date: "yyyy/mm/dd",
};

/* A wide character takes two cells' width. */
const widthOfText = (s: string): number => [...s].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0);
const shownInSheet = (cell: ExportCell, format: ExportFormat): string => {
  if (cell === null) return "";
  if (typeof cell === "number" && (format === "money" || format === "rate")) {
    return cell.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: format === "rate" ? 4 : 2 });
  }
  if (format === "date" && excelDaySerial(String(cell)) !== null) return "0000/00/00";
  return String(cell);
};

/** Each column as wide as the longest thing in it (owner 2026-11-06: 我要看 export 出来的
 *  成效). Read off the heading alone, a "Document" column cut every document number. */
export function fittedColumnWidths(matrix: LineExportMatrix): number[] {
  return matrix.header.map((heading, c) => {
    const format = matrix.formats[c] ?? "text";
    const widest = matrix.body.reduce((w, row) => Math.max(w, widthOfText(shownInSheet(row[c] ?? null, format))), widthOfText(heading));
    return Math.min(42, Math.max(10, widest + 2));
  });
}

type Xlsx = typeof import("../lib/xlsx-runtime");

/** One sheet: the lines above its table, if any (a title, a note — then a blank row),
 *  the header and rows, each column's Excel format, each column fitted. */
function sheetOf(XLSX: Xlsx, matrix: LineExportMatrix, heading: readonly string[] = []): Record<string, unknown> {
  const above = heading.length > 0 ? [...heading.map((line) => [line]), []] : [];
  const ws = XLSX.utils.aoa_to_sheet([...above, matrix.header, ...matrix.body]) as Record<string, unknown>;
  const first = above.length + 1;
  matrix.formats.forEach((fmt, c) => {
    const z = NUMBER_FORMAT[fmt];
    if (!z) return;
    for (let r = first; r < first + matrix.body.length; r += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr] as { t?: string; v?: unknown; z?: string } | undefined;
      if (!cell) continue;
      if (fmt === "date" && typeof cell.v === "string") {
        const serial = excelDaySerial(cell.v);
        if (serial === null) continue;
        ws[addr] = { t: "n", v: serial, z };
      } else if (cell.t === "n") {
        cell.z = z;
      }
    }
  });
  ws["!cols"] = fittedColumnWidths(matrix).map((wch) => ({ wch }));
  return ws;
}

export async function writeLineExportFile(
  matrix: LineExportMatrix, sheetName: string, fileName: string, heading?: readonly string[],
): Promise<void> {
  await writeLineExportBook([{ name: sheetName, matrix, heading }], fileName);
}

/** Several tables in ONE workbook, a sheet each, in the order given — Payments not
 *  matched yet's "Export all" (owner 2026-11-10: 一个 Excel，分三张表). A sheet's
 *  `heading` is printed above its table, a line a row: what the list is and what
 *  narrowed it (owner 2026-11-11: export 出来时注明是 …). */
export async function writeLineExportBook(
  sheets: ReadonlyArray<{ name: string; matrix: LineExportMatrix; heading?: readonly string[] }>, fileName: string,
): Promise<void> {
  const XLSX = await import("../lib/xlsx-runtime");
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, sheetOf(XLSX, s.matrix, s.heading), s.name);
  XLSX.writeFileXLSX(wb, fileName);
}
