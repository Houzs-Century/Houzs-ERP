// ----------------------------------------------------------------------------
// fabric-csv — export + import helpers for Fabric Converter.
// Commander 2026-05-26: avoid one-by-one form entry; round-trip via Excel.
//
// Export shape: every catalog + metric column the API exposes (except `id`,
// which is derived from fabric_code on import). UTF-8 BOM so Excel opens
// without garbled non-ASCII.
//
// Import shape: must have a `fabric_code` column (the match key). Other
// columns are optional — only those present overwrite the corresponding DB
// field. Unknown columns are reported as warnings, not errors.
//
// The owner's staff keep the fabric list in Excel and had to hand-convert to
// CSV before importing ("任何文档进去都可以 import"). Both formats are accepted
// now: CSV goes through parseCsv, .xlsx/.xls through parseWorkbook — BOTH feed
// the SAME grid mapper (parseGridRows) so the two paths normalise identically.
// parseImportFile picks by extension so callers stay one line.
// ----------------------------------------------------------------------------

import type { FabricTrackingRow } from './fabric-queries';

type ColKind = 'text' | 'int';

export type CsvColumn = {
  csv:    string;                   // header label
  field:  keyof FabricTrackingRow;  // DB row field
  apiKey: string;                   // body key for bulk-upsert
  kind:   ColKind;
};

export const CSV_COLUMNS: CsvColumn[] = [
  { csv: 'fabric_code',             field: 'fabric_code',             apiKey: 'fabricCode',           kind: 'text' },
  { csv: 'series',                  field: 'series',                  apiKey: 'series',               kind: 'text' },
  { csv: 'fabric_description',      field: 'fabric_description',      apiKey: 'fabricDescription',    kind: 'text' },
  { csv: 'supplier_code',           field: 'supplier_code',           apiKey: 'supplierCode',         kind: 'text' },
  { csv: 'supplier',                field: 'supplier',                apiKey: 'supplier',             kind: 'text' },
  { csv: 'sofa_price_tier',         field: 'sofa_price_tier',         apiKey: 'sofaPriceTier',        kind: 'text' },
  { csv: 'bedframe_price_tier',     field: 'bedframe_price_tier',     apiKey: 'bedframePriceTier',    kind: 'text' },
  { csv: 'price_sen',             field: 'price_sen',             apiKey: 'priceSen',           kind: 'int' },
  { csv: 'soh_sen',               field: 'soh_sen',               apiKey: 'sohSen',             kind: 'int' },
  { csv: 'po_outstanding_sen',    field: 'po_outstanding_sen',    apiKey: 'poOutstandingSen',   kind: 'int' },
  { csv: 'last_month_usage_sen',  field: 'last_month_usage_sen',  apiKey: 'lastMonthUsageSen',  kind: 'int' },
  { csv: 'one_week_usage_sen',    field: 'one_week_usage_sen',    apiKey: 'oneWeekUsageSen',    kind: 'int' },
  { csv: 'two_weeks_usage_sen',   field: 'two_weeks_usage_sen',   apiKey: 'twoWeeksUsageSen',   kind: 'int' },
  { csv: 'one_month_usage_sen',   field: 'one_month_usage_sen',   apiKey: 'oneMonthUsageSen',   kind: 'int' },
  { csv: 'shortage_sen',          field: 'shortage_sen',          apiKey: 'shortageSen',        kind: 'int' },
  { csv: 'reorder_point_sen',     field: 'reorder_point_sen',     apiKey: 'reorderPointSen',    kind: 'int' },
  { csv: 'lead_time_days',          field: 'lead_time_days',          apiKey: 'leadTimeDays',         kind: 'int' },
];

const HEADER_TO_API: Record<string, CsvColumn> = Object.fromEntries(
  CSV_COLUMNS.map((c) => [c.csv, c]),
);

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: FabricTrackingRow[]): string {
  const header = CSV_COLUMNS.map((c) => c.csv).join(',');
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c.field])).join(',')).join('\r\n');
  return '﻿' + header + '\r\n' + body + '\r\n';
}

// Parse CSV text into a 2D grid. Handles quoted fields (including embedded
// commas, CRLF, and "" escapes). Tolerant of mixed line endings.
function parseGrid(text: string): string[][] {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; continue; }
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') { inQuotes = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

export type ParsedImport = {
  rows:     Array<Record<string, unknown>>;
  errors:   string[];
  warnings: string[];
};

/* Header matching is tolerant of case AND of space-vs-underscore, so a
   hand-made Excel sheet with "Fabric Code" maps to the same column as the
   round-trip export's "fabric_code". Runs of whitespace/underscore collapse to
   one underscore; the CSV_COLUMNS keys are already lower snake_case, so this is
   identity on an exported file and only ever LOOSENS matching. */
function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_]+/g, '_');
}

// Map a parsed grid (row 0 = headers, the rest = data) into the camelCase row
// shape bulk-upsert expects. The single normalisation point for BOTH the CSV
// and the Excel path — do not duplicate this logic in either caller.
function parseGridRows(grid: string[][]): ParsedImport {
  if (grid.length < 1) return { rows: [], errors: ['The file is empty'], warnings: [] };
  const header = (grid[0] ?? []).map(normalizeHeader);
  if (!header.includes('fabric_code')) {
    return { rows: [], errors: ['Header must include a fabric_code column'], warnings: [] };
  }
  const unknown = header.filter((h) => h && !HEADER_TO_API[h]);
  const warnings = unknown.length ? [`Ignoring unknown columns: ${unknown.join(', ')}`] : [];

  const rows: Array<Record<string, unknown>> = [];
  const errors: string[] = [];

  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    if (!cells || cells.every((c) => c.trim() === '')) continue;

    const obj: Record<string, unknown> = {};
    let rowOk = true;
    for (let c = 0; c < header.length; c++) {
      const headerKey = header[c];
      if (!headerKey) continue;
      const col = HEADER_TO_API[headerKey];
      if (!col) continue;
      const raw = (cells[c] ?? '').trim();
      if (col.kind === 'int') {
        if (raw === '') { obj[col.apiKey] = null; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          errors.push(`Row ${r + 1}: ${col.csv} not a number ("${raw}")`);
          rowOk = false;
          break;
        }
        obj[col.apiKey] = n;
      } else {
        obj[col.apiKey] = raw === '' ? null : raw;
      }
    }
    if (!rowOk) continue;
    if (typeof obj.fabricCode !== 'string' || (obj.fabricCode as string).length === 0) {
      errors.push(`Row ${r + 1}: missing fabric_code`);
      continue;
    }
    rows.push(obj);
  }
  return { rows, errors, warnings };
}

export function parseCsv(text: string): ParsedImport {
  return parseGridRows(parseGrid(text));
}

// Excel (.xlsx/.xls/...) → the SAME row shape as parseCsv. First sheet only,
// first row = headers. `raw: false` renders every cell as a string (dates,
// numbers) so cell-typing matches the CSV path where everything arrives as
// text and parseGridRows re-parses the int columns. SheetJS is loaded lazily
// (the same lib the SKU/Products import already uses) so its parser chunk stays
// out of the main bundle.
export async function parseWorkbook(buffer: ArrayBuffer): Promise<ParsedImport> {
  const XLSX = await import('../../../lib/xlsx-runtime');
  const wb = XLSX.read(buffer, { type: 'array' });
  const first = wb.SheetNames[0];
  const sheet = first ? wb.Sheets[first] : undefined;
  if (!sheet) return { rows: [], errors: ['The workbook has no sheets'], warnings: [] };
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' });
  const grid = aoa.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []));
  return parseGridRows(grid);
}

const WORKBOOK_EXT = /\.(xlsx|xls|xlsm|xlsb)$/i;

// One entry point for the file picker: dispatch on extension so a caller does
// not have to know CSV from Excel. A workbook that SheetJS cannot open (a
// mislabelled or corrupt file) becomes a readable error rather than an
// unhandled rejection.
export async function parseImportFile(file: File): Promise<ParsedImport> {
  if (WORKBOOK_EXT.test(file.name)) {
    try {
      return await parseWorkbook(await file.arrayBuffer());
    } catch {
      return { rows: [], errors: ['This file could not be read as an Excel workbook. Re-save it as .xlsx or export to CSV and try again.'], warnings: [] };
    }
  }
  return parseCsv(await file.text());
}

/* Surface the REAL reason a whole import was refused (owner: "可不可以显示失败的
   原因"). authed-fetch stashes the raw response body on `err.body`; the server's
   refusal carries a `reason` sentence and, when the clash is per-code, the
   conflicting `ids`. humanApiError picks at most the reason and always drops the
   id list, so the operator never learned WHICH codes clashed. This pulls both
   out for the import result UI. Returns null when the body says nothing more
   specific than the humanised message already does. */
export function importErrorDetail(err: unknown): string | null {
  const body = (err as { body?: unknown } | null | undefined)?.body;
  if (typeof body !== 'string') return null;
  let parsed: { reason?: unknown; ids?: unknown; message?: unknown };
  try { parsed = JSON.parse(body) as typeof parsed; } catch { return null; }
  const parts: string[] = [];
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim()
    : typeof parsed.message === 'string' ? parsed.message.trim() : '';
  if (reason) parts.push(reason);
  const ids = Array.isArray(parsed.ids)
    ? parsed.ids.map((x) => String(x ?? '').trim()).filter(Boolean)
    : [];
  if (ids.length) parts.push(`Conflicting code${ids.length === 1 ? '' : 's'}: ${ids.join(', ')}`);
  return parts.length ? parts.join('\n') : null;
}

export function triggerDownload(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
