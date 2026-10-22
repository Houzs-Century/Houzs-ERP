// Browser I/O for the role-matrix Excel export/import. The MEANING is all in
// roleMatrixExcel.ts (pure, unit-tested); this file only turns a WorkbookData
// into a downloaded .xlsx and an uploaded .xlsx/.csv into SheetData[]. SheetJS
// stays lazy (xlsx-runtime) so it is not in the main bundle.

import { parseCSV } from "./csv";
import type { CellValue, SheetData, WorkbookData, MatrixSnapshot } from "./roleMatrixExcel";
import { buildWorkbook } from "./roleMatrixExcel";

const WORKBOOK_EXT = /\.(xlsx|xls|xlsm|xlsb)$/i;

export const UNREADABLE_MATRIX_FILE =
  "This file could not be read as a spreadsheet. Export the matrix first, edit that file, and import it back.";

/** Every sheet of a workbook's bytes as SheetData (names kept for the bad-cell
 *  report). Typed cells are rendered to the text Excel shows (raw:false) so a
 *  tick stays a tick. Split from `readMatrixSheets` so the real SheetJS path is
 *  testable without a `File` (jsdom's File has no arrayBuffer/text). */
export async function readWorkbookBytes(buffer: ArrayBuffer): Promise<SheetData[]> {
  const XLSX = await import("./xlsx-runtime");
  const wb = XLSX.read(buffer, { type: "array", raw: false });
  return wb.SheetNames.map((name) => ({
    name,
    aoa: XLSX.utils.sheet_to_json<CellValue[]>(wb.Sheets[name]!, {
      header: 1,
      raw: false,
      defval: "",
    }),
  }));
}

/** Read an uploaded file to SheetData[]: every sheet of a workbook, or the
 *  single grid of a CSV. */
export async function readMatrixSheets(file: File): Promise<SheetData[]> {
  if (!WORKBOOK_EXT.test(file.name)) {
    const aoa = parseCSV(await file.text()) as CellValue[][];
    return [{ name: file.name.replace(/\.csv$/i, "") || "CSV", aoa }];
  }
  return readWorkbookBytes(await file.arrayBuffer());
}

/** Column widths from the longest cell in each column (clamped), so the exported
 *  sheet is readable without manual resizing. */
function colWidths(aoa: CellValue[][]): Array<{ wch: number }> {
  const widths: number[] = [];
  for (const row of aoa) {
    row.forEach((cell, c) => {
      const len = cell === null ? 0 : String(cell).length;
      widths[c] = Math.max(widths[c] ?? 0, len);
    });
  }
  return widths.map((w) => ({ wch: Math.min(44, Math.max(8, w + 2)) }));
}

/** A WorkbookData serialized to real .xlsx bytes. Exported (not just the
 *  download) so a test can round-trip export → read with real SheetJS. */
export async function workbookToXlsx(wb: WorkbookData): Promise<ArrayBuffer> {
  const XLSX = await import("./xlsx-runtime");
  const out = XLSX.utils.book_new();
  for (const s of wb.sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    (ws as Record<string, unknown>)["!cols"] = colWidths(s.aoa);
    // Excel caps a sheet name at 31 chars; our names are shorter, but clamp to
    // be safe against a future rename.
    XLSX.utils.book_append_sheet(out, ws, s.name.slice(0, 31));
  }
  return XLSX.writeXLSX(out, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

function downloadBytes(bytes: ArrayBuffer, fileName: string): void {
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** One-click export of the whole matrix. The file name carries the date so the
 *  owner can tell versions apart in his Downloads. */
export async function exportRoleMatrix(snap: MatrixSnapshot): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const bytes = await workbookToXlsx(buildWorkbook(snap));
  downloadBytes(bytes, `Houzs-RBAC-角色权限矩阵-${today}.xlsx`);
}
