// ----------------------------------------------------------------------------
// fabric-csv — CSV export + import helpers for Fabric Converter.
// Commander 2026-05-26: avoid one-by-one form entry; round-trip via Excel.
//
// Export shape: every catalog + metric column the API exposes (except `id`,
// which is derived from fabric_code on import). UTF-8 BOM so Excel opens
// without garbled non-ASCII.
//
// Import shape: must have a `fabric_code` column (the match key). Other
// columns are optional — only those present overwrite the corresponding DB
// field. Unknown columns are reported as warnings, not errors.
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
  { csv: 'price_centi',             field: 'price_centi',             apiKey: 'priceCenti',           kind: 'int' },
  { csv: 'soh_centi',               field: 'soh_centi',               apiKey: 'sohCenti',             kind: 'int' },
  { csv: 'po_outstanding_centi',    field: 'po_outstanding_centi',    apiKey: 'poOutstandingCenti',   kind: 'int' },
  { csv: 'last_month_usage_centi',  field: 'last_month_usage_centi',  apiKey: 'lastMonthUsageCenti',  kind: 'int' },
  { csv: 'one_week_usage_centi',    field: 'one_week_usage_centi',    apiKey: 'oneWeekUsageCenti',    kind: 'int' },
  { csv: 'two_weeks_usage_centi',   field: 'two_weeks_usage_centi',   apiKey: 'twoWeeksUsageCenti',   kind: 'int' },
  { csv: 'one_month_usage_centi',   field: 'one_month_usage_centi',   apiKey: 'oneMonthUsageCenti',   kind: 'int' },
  { csv: 'shortage_centi',          field: 'shortage_centi',          apiKey: 'shortageCenti',        kind: 'int' },
  { csv: 'reorder_point_centi',     field: 'reorder_point_centi',     apiKey: 'reorderPointCenti',    kind: 'int' },
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

export function parseCsv(text: string): ParsedImport {
  const grid = parseGrid(text);
  if (grid.length < 1) return { rows: [], errors: ['Empty CSV'], warnings: [] };
  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase());
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
