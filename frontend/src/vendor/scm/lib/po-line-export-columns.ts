/* The Purchase Order LINE export — one row per PO line, the AutoCount
   "PO chasing list" shape the owner asked for on 2026-09-15.

   THIS FILE IS A CONTRACT, not a formatting detail. The export's header names
   and its "Line ID" column are what an import reads back: rows are matched by
   Line ID and only the editable columns are written. Rename a header here and
   every file already exported stops importing.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/po-line-export-columns.ts
   (the frontend writes the sheet, the server builds the rows). Refereed by
   frontend/src/vendor/scm/lib/po-line-export-columns.canonical.test.ts and by
   backend/scripts/check-shared-mirrors.mjs. No imports, so the two copies can
   stay identical. */

/* WHICH STORED DATE IS "Estimate Delivery Date 1 / 2 / 3". The ONE place that
   decides it — correct it here and every screen and export reading the
   estimates follows (the PO line export and the Outstanding "PO Chasing" tab).

   Checked against live AutoCount 2026-09-15: the book keeps these three on the
   PO HEADER as UDF_EDate / UDF_EDate2 / UDF_EDate3 (captioned "Supplier
   Delivery Date"). The ERP keeps the same three dates as
   supplier_delivery_date_2/3/4 — on the purchase_orders header, cascaded onto
   every line (POST /bulk-supplier-date), and editable per line on PoLineCard
   ("Supplier Date 2/3/4"). delivery_date stays the line's own Delivery Date.

   A LINE value wins over the header's: the line is where a date that differs
   per item lives, and the cascade writes both halves the same. The header value
   is used only where the line is blank. */
export const PO_ESTIMATE_DELIVERY_DATE_FIELDS = [
  'supplier_delivery_date_2',
  'supplier_delivery_date_3',
  'supplier_delivery_date_4',
] as const;

/** What the three are called, on every screen and in every export. */
export const PO_ESTIMATE_DELIVERY_DATE_LABELS = [
  'Estimate Delivery Date 1',
  'Estimate Delivery Date 2',
  'Estimate Delivery Date 3',
] as const;

export type PoEstimateDates = {
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  supplier_delivery_date_4?: string | null;
};

/** Estimate Delivery Date 1, 2, 3 for one line: the line's own date, else the
 *  PO header's, as YYYY-MM-DD or null. */
export function poEstimateDeliveryDates(
  line: PoEstimateDates,
  header: PoEstimateDates | null | undefined,
): [string | null, string | null, string | null] {
  const pick = (i: 0 | 1 | 2): string | null => {
    const field = PO_ESTIMATE_DELIVERY_DATE_FIELDS[i];
    return isoDate(line[field]) ?? isoDate(header?.[field]);
  };
  return [pick(0), pick(1), pick(2)];
}

/* The word the Purchase Orders LIST shows for each stored status — the export
   prints the same word (owner 2026-09-15), and the list reads its labels from
   here so the two cannot drift. A held order keeps its real status and carries
   the hold MARKER beside it (mig 0324), which the list draws as a chip; the
   export writes it after the word. */
export const PO_STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
  ON_HOLD: 'On Hold',
};

export function poStatusWord(status: string | null | undefined, onHold: boolean | null | undefined): string | null {
  const raw = (status ?? '').trim();
  if (!raw) return null;
  const word = PO_STATUS_WORDS[raw.toUpperCase()] ?? raw;
  return onHold === true && raw.toUpperCase() !== 'ON_HOLD' ? `${word} (On Hold)` : word;
}

export const PO_LINE_EXPORT_COLUMNS = [
  'Doc No',
  'AutoCount Doc No',
  'Doc Date',
  'Status',
  'Supplier Code',
  'Supplier Name',
  'SO Doc No.',
  'Item Code',
  'Supplier SKU',
  'Item Description',
  'Item Description 2',
  'Remarks',
  'Category',
  'Location',
  'Qty',
  'Received Qty',
  'Remaining Qty',
  'Unit Price',
  'Line Total',
  'Delivery Date',
  ...PO_ESTIMATE_DELIVERY_DATE_LABELS,
  'Line ID',
] as const;

export type PoLineExportColumn = (typeof PO_LINE_EXPORT_COLUMNS)[number];
export type PoLineExportCell = string | number | null;

/* Spreadsheet number formats for the non-text columns. A money cell is a
   NUMBER in ringgit, so the sheet can sum it; the format only controls how many
   decimals show. A unit price is a rate and keeps up to four. */
export const PO_LINE_EXPORT_NUMBER_FORMATS: Partial<Record<PoLineExportColumn, string>> = {
  'Qty': '0.##',
  'Received Qty': '0.##',
  'Remaining Qty': '0.##',
  'Unit Price': '#,##0.00##',
  'Line Total': '#,##0.00',
};

export type PoExportHeader = PoEstimateDates & {
  po_number: string | null;
  linked_ac_docno?: string | null;
  po_date: string | null;
  status: string | null;
  on_hold?: boolean | null;
  supplier?: { code?: string | null; name?: string | null } | null;
};

export type PoExportLine = PoEstimateDates & {
  id: string;
  item_code: string | null;
  supplier_sku?: string | null;
  material_name: string | null;
  description2?: string | null;
  notes?: string | null;
  item_group?: string | null;
  qty: number | string | null;
  received_qty?: number | string | null;
  unit_price_sen?: number | string | null;
  line_total_sen?: number | string | null;
  delivery_date?: string | null;
};

export type PoExportLineContext = {
  /** The Sales Order the line was raised for (via so_item_id), or null. */
  soDocNo: string | null;
  /** AutoCount's short location code (`KL`) for the line's warehouse, falling
   *  back to the PO header's — resolved by the server through the write-back's
   *  own LOCATION_MAP, so the file names a warehouse the way the book does. */
  location: string | null;
};

const text = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* The storage shape (YYYY-MM-DD) — a spreadsheet sorts it, and it imports back
   without a day/month guess. A timestamp keeps only its date. */
const isoDate = (v: string | null | undefined): string | null => {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : s;
};

/* Stored in sen; exported in ringgit. `places` rounds away float noise only —
   a whole-sen amount never gains or loses a digit. */
const ringgit = (sen: number | string | null | undefined, places: number): number | null => {
  const n = num(sen);
  if (n === null) return null;
  return Number((n / 100).toFixed(places));
};

export function poLineExportCells(
  header: PoExportHeader,
  line: PoExportLine,
  ctx: PoExportLineContext,
): PoLineExportCell[] {
  const qty = num(line.qty) ?? 0;
  const received = num(line.received_qty) ?? 0;
  const [est1, est2, est3] = poEstimateDeliveryDates(line, header);
  const byColumn: Record<PoLineExportColumn, PoLineExportCell> = {
    'Doc No': text(header.po_number),
    'AutoCount Doc No': text(header.linked_ac_docno),
    'Doc Date': isoDate(header.po_date),
    'Status': poStatusWord(header.status, header.on_hold),
    'Supplier Code': text(header.supplier?.code),
    'Supplier Name': text(header.supplier?.name),
    'SO Doc No.': text(ctx.soDocNo),
    'Item Code': text(line.item_code),
    'Supplier SKU': text(line.supplier_sku),
    'Item Description': text(line.material_name),
    'Item Description 2': text(line.description2),
    'Remarks': text(line.notes),
    'Category': text(line.item_group),
    'Location': text(ctx.location),
    'Qty': qty,
    'Received Qty': received,
    'Remaining Qty': Number((qty - received).toFixed(4)),
    'Unit Price': ringgit(line.unit_price_sen, 4),
    'Line Total': ringgit(line.line_total_sen, 2),
    'Delivery Date': isoDate(line.delivery_date),
    [PO_ESTIMATE_DELIVERY_DATE_LABELS[0]]: est1,
    [PO_ESTIMATE_DELIVERY_DATE_LABELS[1]]: est2,
    [PO_ESTIMATE_DELIVERY_DATE_LABELS[2]]: est3,
    'Line ID': line.id,
  };
  return PO_LINE_EXPORT_COLUMNS.map((col) => byColumn[col]);
}
