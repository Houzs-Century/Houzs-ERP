/* PO line import — the ONE mapping from the exported PO-lines spreadsheet to the
 * database, and the parsing both surfaces share.
 *
 * Owner ruling 2026-09-15 (option A): staff export the PO lines, edit them in
 * Excel and import the file back. Only these six columns may change anything:
 * 「基本上就是改交货日期、预计交货的东西吧，就像你说的 description 2 跟备注这些」.
 * Quantity, price and item are NEVER read from the file — they go through the
 * amendment flow. That guarantee is structural: this list is the only thing the
 * importer looks up, so a column that is not here cannot reach a write.
 *
 * Estimate Delivery Date 1/2/3 are PO-LEVEL (settled 2026-09-15 against live
 * AutoCount: they are the book's header UDF_EDate / UDF_EDate2 / UDF_EDate3).
 * The ERP stores them on the purchase_orders header and cascades them down to
 * every line, exactly like the bulk supplier-date action. Delivery Date,
 * Item Description 2 and Remarks are per line.
 *
 * Two byte-identical copies: backend/src/scm/lib/po-line-import.ts (what the
 * server classifies and writes by) and frontend/src/vendor/scm/lib/po-line-import.ts
 * (what the import dialog reads the file with). po-line-import.canonical.test.ts
 * fails the build if they drift. The header names and which stored date is
 * "Estimate Delivery Date" / "Supplier Delivery Date 2/3" come from the grid's
 * column labels beside it, po-line-export-columns.ts, so a renamed column is a
 * compile error here.
 *
 * THE FILE IS WHATEVER THE GRID EXPORTED (owner 2026-09-15: the export follows
 * the columns the operator shows). So every editable column is OPTIONAL: an
 * absent column changes nothing, and the preview names it. Only Doc No (or ERP
 * Doc No) and Line ID are required — without them a row cannot be tied to a
 * line safely. */
import {
  PO_ESTIMATE_DELIVERY_DATE_FIELDS,
  PO_LINE_LABELS,
  type PoLineLabel,
} from './po-line-export-columns';

export type PoLineImportField =
  | 'deliveryDate'
  | 'estimateDeliveryDate1'
  | 'estimateDeliveryDate2'
  | 'estimateDeliveryDate3'
  | 'description2'
  | 'remarks';

export type PoLineImportFieldSpec = {
  field: PoLineImportField;
  /** The grid's column label, exactly. Matched case- and space-insensitively. */
  header: PoLineLabel;
  /** Headers an earlier export wrote for the same field (2026-09-15, before the
   *  AutoCount captions), still read so a file already exported imports. */
  legacyHeaders: readonly string[];
  kind: 'date' | 'text';
  /** 'line' = purchase_order_items.<column>; 'po' = purchase_orders.<column>, cascaded to every line. */
  level: 'line' | 'po';
  column: string;
  /** Supplier-revised slot number for the PO-level dates (the bulk supplier-date action's `slot`). */
  slot: 2 | 3 | 4 | null;
};

export const PO_LINE_IMPORT_FIELDS: readonly PoLineImportFieldSpec[] = [
  { field: 'deliveryDate', header: PO_LINE_LABELS.deliveryDate, legacyHeaders: [], kind: 'date', level: 'line', column: 'delivery_date', slot: null },
  { field: 'estimateDeliveryDate1', header: PO_LINE_LABELS.estimate1, legacyHeaders: ['Estimate Delivery Date 1'], kind: 'date', level: 'po', column: PO_ESTIMATE_DELIVERY_DATE_FIELDS[0], slot: 2 },
  { field: 'estimateDeliveryDate2', header: PO_LINE_LABELS.estimate2, legacyHeaders: ['Estimate Delivery Date 2'], kind: 'date', level: 'po', column: PO_ESTIMATE_DELIVERY_DATE_FIELDS[1], slot: 3 },
  { field: 'estimateDeliveryDate3', header: PO_LINE_LABELS.estimate3, legacyHeaders: ['Estimate Delivery Date 3'], kind: 'date', level: 'po', column: PO_ESTIMATE_DELIVERY_DATE_FIELDS[2], slot: 4 },
  { field: 'description2', header: PO_LINE_LABELS.itemDescription2, legacyHeaders: [], kind: 'text', level: 'line', column: 'description2', slot: null },
  { field: 'remarks', header: PO_LINE_LABELS.remarks, legacyHeaders: [], kind: 'text', level: 'line', column: 'notes', slot: null },
];

/** Doc No (AutoCount's number when the PO is linked, else the ERP's) and ERP Doc
 *  No; a file may carry either or both. */
export const PO_LINE_IMPORT_DOC_NO_HEADER: PoLineLabel = PO_LINE_LABELS.docNo;
export const PO_LINE_IMPORT_ERP_DOC_NO_HEADER: PoLineLabel = PO_LINE_LABELS.erpDocNo;
export const PO_LINE_IMPORT_LINE_ID_HEADER: PoLineLabel = PO_LINE_LABELS.lineId;

/** Rows read from one file. An export of every open PO line is a few thousand. */
export const PO_LINE_IMPORT_MAX_ROWS = 5000;
/** Lines one apply may write. Each is its own audited UPDATE inside one transaction. */
export const PO_LINE_IMPORT_MAX_LINE_CHANGES = 500;
/** PO-level estimate-date changes one apply may cascade. */
export const PO_LINE_IMPORT_MAX_PO_CHANGES = 200;
export const PO_LINE_IMPORT_MAX_TEXT = 1000;

export const poLineImportSpec = (field: PoLineImportField): PoLineImportFieldSpec => {
  const spec = PO_LINE_IMPORT_FIELDS.find((f) => f.field === field);
  if (!spec) throw new Error(`Unknown PO line import field: ${field}`);
  return spec;
};

export const isPoLineImportField = (v: unknown): v is PoLineImportField =>
  typeof v === 'string' && PO_LINE_IMPORT_FIELDS.some((f) => f.field === v);

/** A raw cell as the spreadsheet reader hands it over. */
export type PoLineImportCell = string | number | boolean | null;

export type PoLineImportRow = {
  /** 1-based row number as Excel shows it, so a rejection can name the row. */
  rowNumber: number;
  docNo: string | null;
  lineId: string | null;
  values: Partial<Record<PoLineImportField, PoLineImportCell>>;
};

const normHeader = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

const cellOf = (v: unknown): PoLineImportCell => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : localDay(v);
  return String(v);
};

const pad2 = (n: number): string => String(n).padStart(2, '0');
const localDay = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const calendarDay = (y: number, m: number, d: number): string | null => {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
};

/* Excel's day 0 is 1899-12-30 for every serial after its fictitious 1900-02-29.
   Accepted only between 1950 and 2100, so a stray small number is an invalid
   date instead of a date in 1900. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const serialDay = (n: number): string | null => {
  if (!Number.isFinite(n) || n < 18264 || n > 73051) return null;
  const t = new Date(EXCEL_EPOCH_MS + Math.floor(n) * 86_400_000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
};

export type ParsedImportValue = { ok: true; value: string | null } | { ok: false; reason: string };

/**
 * A date cell: ISO yyyy-mm-dd (a time part is ignored), an Excel date serial, or
 * dd/mm/yyyy. A blank cell is a real value — null — because the file is an
 * export: a blank that was blank stays unchanged, and a date the user deleted
 * clears it.
 */
export function parseImportDate(raw: unknown): ParsedImportValue {
  const cell = cellOf(raw);
  if (cell === null) return { ok: true, value: null };
  if (typeof cell === 'boolean') return { ok: false, reason: 'not a date' };
  if (typeof cell === 'number') {
    const v = serialDay(cell);
    return v ? { ok: true, value: v } : { ok: false, reason: `${cell} is not a date` };
  }
  const s = cell.trim();
  if (s === '') return { ok: true, value: null };
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][0-9:.]+Z?)?$/.exec(s);
  if (m) {
    const v = calendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
    return v ? { ok: true, value: v } : { ok: false, reason: `"${s}" is not a calendar date` };
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const v = calendarDay(Number(m[3]), Number(m[2]), Number(m[1]));
    return v ? { ok: true, value: v } : { ok: false, reason: `"${s}" is not a calendar date (dd/mm/yyyy)` };
  }
  if (/^\d+(\.\d+)?$/.test(s)) {
    const v = serialDay(Number(s));
    return v ? { ok: true, value: v } : { ok: false, reason: `"${s}" is not a date` };
  }
  return { ok: false, reason: `"${s}" is not a date (use yyyy-mm-dd or dd/mm/yyyy)` };
}

/** A text cell: trimmed; blank is null. */
export function parseImportText(raw: unknown): ParsedImportValue {
  const cell = cellOf(raw);
  if (cell === null) return { ok: true, value: null };
  const s = String(cell).trim();
  if (s.length > PO_LINE_IMPORT_MAX_TEXT) {
    return { ok: false, reason: `longer than ${PO_LINE_IMPORT_MAX_TEXT} characters` };
  }
  return { ok: true, value: s === '' ? null : s };
}

export function parseImportValue(field: PoLineImportField, raw: unknown): ParsedImportValue {
  return poLineImportSpec(field).kind === 'date' ? parseImportDate(raw) : parseImportText(raw);
}

/**
 * The value a STORED column holds, in the same shape a parsed cell has, so the two
 * compare with ===. A date column arrives as 'YYYY-MM-DD' over PostgREST and as a
 * JS Date inside a postgres.js transaction; both land on the day string.
 */
export function storedImportValue(field: PoLineImportField, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (poLineImportSpec(field).kind === 'date') {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    const s = String(v).trim();
    return s === '' ? null : s.slice(0, 10);
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

export type PoLineImportSheet =
  | { ok: true; rows: PoLineImportRow[]; fields: PoLineImportField[]; ignoredHeaders: string[]; missingHeaders: string[] }
  | { ok: false; error: string };

/**
 * Read a sheet given as rows of cells (SheetJS `sheet_to_json(ws, { header: 1 })`).
 * The header row is the first of the top ten that names a Line ID column. Every
 * column that is not Doc No, ERP Doc No, Line ID or one of the six fields is
 * ignored; an editable column the file does not carry is reported in
 * `missingHeaders` and changes nothing.
 */
export function readPoLineImportSheet(matrix: unknown[][]): PoLineImportSheet {
  const lineIdKey = normHeader(PO_LINE_IMPORT_LINE_ID_HEADER);
  const docNoKey = normHeader(PO_LINE_IMPORT_DOC_NO_HEADER);
  const headerIdx = matrix.slice(0, 10).findIndex((r) => Array.isArray(r) && r.some((c) => normHeader(c) === lineIdKey));
  if (headerIdx < 0) {
    return { ok: false, error: `This file has no "${PO_LINE_IMPORT_LINE_ID_HEADER}" column. Show the ${PO_LINE_IMPORT_LINE_ID_HEADER} column on the Purchase Orders list (Columns), export again, and import that file.` };
  }
  const header = matrix[headerIdx] as unknown[];
  const colOf = (key: string): number => header.findIndex((c) => normHeader(c) === key);
  const lineIdCol = colOf(lineIdKey);
  const acDocNoCol = colOf(docNoKey);
  const erpDocNoCol = colOf(normHeader(PO_LINE_IMPORT_ERP_DOC_NO_HEADER));
  const docNoCol = acDocNoCol >= 0 ? acDocNoCol : erpDocNoCol;
  if (docNoCol < 0) {
    return { ok: false, error: `This file has no "${PO_LINE_IMPORT_DOC_NO_HEADER}" or "${PO_LINE_IMPORT_ERP_DOC_NO_HEADER}" column. Show one of them on the Purchase Orders list (Columns), export again, and import that file.` };
  }
  const fieldCols: Array<[PoLineImportField, number]> = [];
  const missingHeaders: string[] = [];
  for (const spec of PO_LINE_IMPORT_FIELDS) {
    let col = colOf(normHeader(spec.header));
    for (const legacy of spec.legacyHeaders) if (col < 0) col = colOf(normHeader(legacy));
    if (col >= 0) fieldCols.push([spec.field, col]);
    else missingHeaders.push(spec.header);
  }
  if (fieldCols.length === 0) {
    return {
      ok: false,
      error: `This file has none of the columns an import can change: ${PO_LINE_IMPORT_FIELDS.map((f) => f.header).join(', ')}.`,
    };
  }
  const used = new Set<number>([lineIdCol, docNoCol, erpDocNoCol, ...fieldCols.map(([, c]) => c)]);
  const ignoredHeaders = header
    .map((c, i) => (used.has(i) ? '' : String(c ?? '').trim()))
    .filter((h) => h !== '');

  const rows: PoLineImportRow[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const r = Array.isArray(matrix[i]) ? (matrix[i] as unknown[]) : [];
    const blank = [lineIdCol, docNoCol, ...fieldCols.map(([, c]) => c)]
      .every((c) => { const v = cellOf(r[c]); return v === null || String(v).trim() === ''; });
    if (blank) continue;
    const text = (c: number): string | null => {
      const v = cellOf(r[c]);
      const s = v === null ? '' : String(v).trim();
      return s === '' ? null : s;
    };
    const values: Partial<Record<PoLineImportField, PoLineImportCell>> = {};
    for (const [field, col] of fieldCols) values[field] = cellOf(r[col]);
    rows.push({ rowNumber: i + 1, docNo: text(docNoCol), lineId: text(lineIdCol), values });
  }
  if (rows.length > PO_LINE_IMPORT_MAX_ROWS) {
    return { ok: false, error: `This file has ${rows.length} rows; one import takes up to ${PO_LINE_IMPORT_MAX_ROWS}. Split the file.` };
  }
  return { ok: true, rows, fields: fieldCols.map(([f]) => f), ignoredHeaders, missingHeaders };
}

/* ── The preview / apply wire contract ───────────────────────────────────── */

export type PoLineImportRejectCode =
  | 'unknown_line'
  | 'other_company'
  | 'po_cancelled'
  | 'po_received'
  | 'po_locked'
  | 'invalid_value'
  | 'doc_no_mismatch'
  | 'duplicate_line';

export type PoLineImportChange = { field: PoLineImportField; old: string | null; new: string | null };

export type PoLineImportRowResult = {
  rowNumber: number;
  docNo: string | null;
  lineId: string | null;
  itemCode: string | null;
} & (
  | { status: 'changes'; changes: PoLineImportChange[] }
  | { status: 'unchanged' }
  | { status: 'rejected'; code: PoLineImportRejectCode; reason: string }
);

/** One PO-level estimate-date change, shown once per PO. */
export type PoLineImportPoChange = {
  poId: string;
  docNo: string;
  field: PoLineImportField;
  old: string | null;
  new: string | null;
  /** Every line of the PO and the value it holds now; the cascade overwrites all of them. */
  lineValues: Record<string, string | null>;
  rowNumbers: number[];
};

export type PoLineImportPoRejection = {
  docNo: string;
  field: PoLineImportField;
  reason: string;
  rowNumbers: number[];
};

export type PoLineImportLineChange = {
  lineId: string;
  docNo: string;
  field: PoLineImportField;
  old: string | null;
  new: string | null;
};

export type PoLineImportPreview = {
  rows: PoLineImportRowResult[];
  poChanges: PoLineImportPoChange[];
  poRejections: PoLineImportPoRejection[];
  /** Exactly what a Confirm sends back to apply. */
  lineChanges: PoLineImportLineChange[];
  counts: { rows: number; changed: number; unchanged: number; rejected: number; poChanges: number; poRejected: number };
};

export type PoLineImportApplyBody = {
  lineChanges: PoLineImportLineChange[];
  poChanges: Array<Pick<PoLineImportPoChange, 'poId' | 'docNo' | 'field' | 'old' | 'new' | 'lineValues'>>;
};

export type PoLineImportConflict = { docNo: string | null; lineId: string | null; field: PoLineImportField | null; reason: string };

export type PoLineImportApplyResult = {
  ok: true;
  linesUpdated: number;
  purchaseOrdersUpdated: number;
  poLevelChanges: number;
  autocountEditsQueued: number;
};
