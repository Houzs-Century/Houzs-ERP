/* The Goods Received LINE export — one row per receipt line (owner 2026-09-15:
   every document list exports one row per line item, across every page its
   filters match). Column design: docs/line-export-columns.md §5.

   THIS FILE IS A CONTRACT, not a formatting detail. The header names and the
   "Line ID" column are what a future import reads back: rows are matched by
   Line ID and only Delivery Date, Item Description 2 and Remarks are written.
   Rename a header here and every file already exported stops importing.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/grn-line-export-columns.ts
   (the frontend writes the sheet, the server builds the rows). Refereed by
   frontend/src/vendor/scm/lib/grn-line-export-columns.canonical.test.ts and by
   backend/scripts/check-shared-mirrors.mjs. No imports, so the two copies can
   stay identical — the same pattern as po-line-export-columns.ts. */

/* The word the Goods Received LIST shows for each stored status — the export
   prints the same word (owner 2026-09-15). The list takes its labels from
   status-pill.ts's GRN map; this file's canonical test asserts the two agree.
   A held receipt keeps its real status and carries the hold MARKER (mig 0324),
   written after the word. */
export const GRN_STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  POSTED: 'Submitted',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
  ON_HOLD: 'On Hold',
};

export function grnStatusWord(status: string | null | undefined, onHold: boolean | null | undefined): string | null {
  const raw = (status ?? '').trim();
  if (!raw) return null;
  const word = GRN_STATUS_WORDS[raw.toUpperCase()] ?? raw;
  return onHold === true && raw.toUpperCase() !== 'ON_HOLD' ? `${word} (On Hold)` : word;
}

export const GRN_LINE_EXPORT_COLUMNS = [
  'Doc No',
  'AutoCount Doc No',
  'Doc Date',
  'Status',
  'Supplier Code',
  'Supplier Name',
  'Supplier DO No.',
  'Item Code',
  'Supplier SKU',
  'Item Description',
  'Item Description 2',
  'Remarks',
  'Category',
  'Location',
  'UOM',
  'Received Qty',
  'Invoiced Qty',
  'Returned Qty',
  'Uninvoiced Qty',
  'Currency',
  'Unit Price',
  'Discount',
  'Line Total',
  'Delivery Date',
  'PO No.',
  'SO Doc No.',
  'Invoice No.',
  'Line ID',
] as const;

export type GrnLineExportColumn = (typeof GRN_LINE_EXPORT_COLUMNS)[number];
export type GrnLineExportCell = string | number | null;

/* Spreadsheet number formats. A money cell is a NUMBER in ringgit, so the sheet
   can sum it; a unit price is a rate and keeps up to four decimals. */
export const GRN_LINE_EXPORT_NUMBER_FORMATS: Partial<Record<GrnLineExportColumn, string>> = {
  'Received Qty': '0.##',
  'Invoiced Qty': '0.##',
  'Returned Qty': '0.##',
  'Uninvoiced Qty': '0.##',
  'Unit Price': '#,##0.00##',
  'Discount': '#,##0.00',
  'Line Total': '#,##0.00',
};

export type GrnExportHeader = {
  grn_number: string | null;
  received_at: string | null;
  status: string | null;
  on_hold?: boolean | null;
  delivery_note_ref?: string | null;
  currency?: string | null;
  linked_ac_docno?: string | null;
  linked_ac_gr_docno?: string | null;
  migrated_no_stock?: boolean | null;
  supplier?: { code?: string | null; name?: string | null } | null;
};

export type GrnExportLine = {
  id: string;
  item_code: string | null;
  supplier_sku?: string | null;
  material_name?: string | null;
  description?: string | null;
  description2?: string | null;
  notes?: string | null;
  item_group?: string | null;
  uom?: string | null;
  qty_accepted: number | string | null;
  returned_qty?: number | string | null;
  unit_price_sen?: number | string | null;
  discount_sen?: number | string | null;
  line_total_sen?: number | string | null;
  delivery_date?: string | null;
};

export type GrnExportLineContext = {
  /** AutoCount's short location code (`KL`) for the receipt's warehouse. */
  location: string | null;
  /** The purchase order the line was received against, via purchase_order_item_id. */
  poNo: string | null;
  /** The sales order that PO line was raised for, via its so_item_id. */
  soDocNo: string | null;
  /** Σ qty of the ERP's purchase invoice lines drawn from this line (owner
   *  2026-09-15: the ERP's own sum, NOT the stored grn_items.invoiced_qty, which
   *  carries pre-go-live AutoCount billing on migrated receipts). */
  invoicedQty: number;
  /** The purchase invoices counted in invoicedQty, joined `, `. */
  invoiceNos: string | null;
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

/* YYYY-MM-DD — a spreadsheet sorts it and it imports back without a day/month
   guess. A timestamp keeps only its date. */
const isoDate = (v: string | null | undefined): string | null => {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : s;
};

/* Stored in sen; exported in ringgit. `places` rounds away float noise only. */
const ringgit = (sen: number | string | null | undefined, places: number): number | null => {
  const n = num(sen);
  if (n === null) return null;
  return Number((n / 100).toFixed(places));
};

/* WHICH COLUMN HOLDS THE AUTOCOUNT GR NUMBER. On a receipt migrated from the
   book (`migrated_no_stock`), `linked_ac_docno` holds the AutoCount PURCHASE
   ORDER number and the GR number sits in `linked_ac_gr_docno` (migration
   20260907T2345_grn_linked_ac_gr_docno.sql); on a receipt the ERP created,
   `linked_ac_docno` IS the GR number. A migrated receipt with no GR number
   prints blank, never its PO number. */
export function grnAutoCountDocNo(h: GrnExportHeader): string | null {
  return h.migrated_no_stock === true ? text(h.linked_ac_gr_docno) : text(h.linked_ac_docno);
}

export function grnLineExportCells(
  header: GrnExportHeader,
  line: GrnExportLine,
  ctx: GrnExportLineContext,
): GrnLineExportCell[] {
  const received = num(line.qty_accepted) ?? 0;
  const returned = num(line.returned_qty) ?? 0;
  const invoiced = Number.isFinite(ctx.invoicedQty) ? ctx.invoicedQty : 0;
  const byColumn: Record<GrnLineExportColumn, GrnLineExportCell> = {
    'Doc No': text(header.grn_number),
    'AutoCount Doc No': grnAutoCountDocNo(header),
    'Doc Date': isoDate(header.received_at),
    'Status': grnStatusWord(header.status, header.on_hold),
    'Supplier Code': text(header.supplier?.code),
    'Supplier Name': text(header.supplier?.name),
    'Supplier DO No.': text(header.delivery_note_ref),
    'Item Code': text(line.item_code),
    'Supplier SKU': text(line.supplier_sku),
    'Item Description': text(line.material_name) ?? text(line.description),
    'Item Description 2': text(line.description2),
    'Remarks': text(line.notes),
    'Category': text(line.item_group),
    'Location': text(ctx.location),
    'UOM': text(line.uom),
    'Received Qty': received,
    'Invoiced Qty': invoiced,
    'Returned Qty': returned,
    'Uninvoiced Qty': Number((received - invoiced - returned).toFixed(4)),
    'Currency': text(header.currency),
    'Unit Price': ringgit(line.unit_price_sen, 4),
    'Discount': ringgit(line.discount_sen, 2),
    'Line Total': ringgit(line.line_total_sen, 2),
    'Delivery Date': isoDate(line.delivery_date),
    'PO No.': text(ctx.poNo),
    'SO Doc No.': text(ctx.soDocNo),
    'Invoice No.': text(ctx.invoiceNos),
    'Line ID': line.id,
  };
  return GRN_LINE_EXPORT_COLUMNS.map((col) => byColumn[col]);
}
