/* One way to read an import file (HC-0003 T5).
 *
 * Every importer (SKU, Fabric, Supplier bindings, PO lines) reads the file
 * here: CSV through parseCSV, Excel through SheetJS. Each importer keeps its
 * own alias map and its own preview before writing. Before this, each one had
 * its own copy of the CSV parser and the workbook reader, and only some of them
 * matched headers loosely. */
import { parseCSV } from './csv';

/** Case, surrounding space and space-vs-underscore never matter in a header. */
export function normalizeImportHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_]+/g, '_');
}

/** Each sheet header -> the importer's own key: a known key matched loosely,
 *  else an alias, else the header as written (trimmed), which the importer
 *  then ignores or reports. A known key keeps its own spelling (`bedframe_P1`). */
export function resolveImportHeaders(
  raw: readonly string[],
  known: readonly string[],
  aliases: Readonly<Record<string, string>>,
): string[] {
  const to = new Map<string, string>();
  for (const [alias, key] of Object.entries(aliases)) to.set(normalizeImportHeader(alias), key);
  for (const key of known) to.set(normalizeImportHeader(key), key);
  return raw.map((h) => to.get(normalizeImportHeader(h)) ?? h.trim());
}

const WORKBOOK_EXT = /\.(xlsx|xls|xlsm|xlsb)$/i;
export const isWorkbookFile = (name: string): boolean => WORKBOOK_EXT.test(name);

export const UNREADABLE_WORKBOOK =
  'This file could not be read as an Excel workbook. Re-save it as .xlsx or export to CSV and try again.';

/** Every sheet as rows of cells. `raw` keeps typed cells (an Excel date stays a
 *  day serial); otherwise every cell is the text Excel shows. Throws when the
 *  bytes are not a workbook. */
export async function readWorkbookSheets(buffer: ArrayBuffer, raw: boolean): Promise<unknown[][][]> {
  const XLSX = await import('./xlsx-runtime');
  const wb = XLSX.read(buffer, { type: 'array', raw });
  return wb.SheetNames.map((name) =>
    XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw, defval: raw ? null : '' }));
}

/** A CSV, or the first sheet of a workbook, as rows of text cells. Blank rows
 *  stay, so an importer's "Row N" matches what Excel shows. */
export async function readImportGrid(file: File): Promise<string[][]> {
  if (!isWorkbookFile(file.name)) return parseCSV(await file.text());
  let sheets: unknown[][][];
  try {
    sheets = await readWorkbookSheets(await file.arrayBuffer(), false);
  } catch {
    throw new Error(UNREADABLE_WORKBOOK);
  }
  return (sheets[0] ?? []).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []));
}
