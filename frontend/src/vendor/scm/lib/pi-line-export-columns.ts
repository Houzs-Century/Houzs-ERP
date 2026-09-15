/* The Purchase Invoice LINE export — one row per invoice line (owner
   2026-09-15: every document list exports one row per line item, across every
   page its filters match). Column design: docs/line-export-columns.md §6.

   THIS FILE IS A CONTRACT, not a formatting detail. The header names and the
   "Line ID" column are what a future import reads back: rows are matched by
   Line ID and only Item Description 2 and Remarks are written. Rename a header
   here and every file already exported stops importing.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/pi-line-export-columns.ts
   (the frontend writes the sheet, the server builds the rows). Refereed by
   frontend/src/vendor/scm/lib/pi-line-export-columns.canonical.test.ts and by
   backend/scripts/check-shared-mirrors.mjs. No imports, so the two copies can
   stay identical — the same pattern as po-line-export-columns.ts. */

/* The word the Purchase Invoices LIST shows for each stored status — the export
   prints the same word (owner 2026-09-15). The list keeps its own STATUS_TONE
   map; this file's canonical test asserts the two say the same words. A held
   invoice keeps its real status and carries the hold MARKER (mig 0324), written
   after the word. */
export const PI_STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  POSTED: 'Submitted',
  PARTIALLY_PAID: 'Partially paid',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
  ON_HOLD: 'On Hold',
};

export function piStatusWord(status: string | null | undefined, onHold: boolean | null | undefined): string | null {
  const raw = (status ?? '').trim();
  if (!raw) return null;
  const word = PI_STATUS_WORDS[raw.toUpperCase()] ?? raw;
  return onHold === true && raw.toUpperCase() !== 'ON_HOLD' ? `${word} (On Hold)` : word;
}

export const PI_LINE_EXPORT_COLUMNS = [
  'Doc No',
  'AutoCount Doc No',
  'Doc Date',
  'Status',
  'Supplier Code',
  'Supplier Name',
  'Supplier Invoice No.',
  'Item Code',
  'Supplier SKU',
  'Item Description',
  'Item Description 2',
  'Remarks',
  'Category',
  'Location',
  'UOM',
  'Qty',
  'Currency',
  'PO Unit Price',
  'Unit Price',
  'Discount',
  'Line Total',
  'Invoice Total',
  'Balance',
  'Due Date',
  'Overdue Days',
  'GRN No.',
  'PO No.',
  'SO Doc No.',
  'Line ID',
] as const;

export type PiLineExportColumn = (typeof PI_LINE_EXPORT_COLUMNS)[number];
export type PiLineExportCell = string | number | null;

/* Spreadsheet number formats. A money cell is a NUMBER in ringgit, so the sheet
   can sum it; a unit price is a rate and keeps up to four decimals. */
export const PI_LINE_EXPORT_NUMBER_FORMATS: Partial<Record<PiLineExportColumn, string>> = {
  'Qty': '0.##',
  'PO Unit Price': '#,##0.00##',
  'Unit Price': '#,##0.00##',
  'Discount': '#,##0.00',
  'Line Total': '#,##0.00',
  'Invoice Total': '#,##0.00',
  'Balance': '#,##0.00',
  'Overdue Days': '0',
};

export type PiExportHeader = {
  invoice_number: string | null;
  linked_ac_docno?: string | null;
  invoice_date: string | null;
  status: string | null;
  on_hold?: boolean | null;
  supplier_invoice_ref?: string | null;
  currency?: string | null;
  due_date?: string | null;
  total_sen?: number | string | null;
  paid_sen?: number | string | null;
  supplier?: { code?: string | null; name?: string | null } | null;
};

export type PiExportLine = {
  id: string;
  item_code: string | null;
  material_name?: string | null;
  description?: string | null;
  description2?: string | null;
  notes?: string | null;
  item_group?: string | null;
  uom?: string | null;
  qty: number | string | null;
  po_unit_price_sen?: number | string | null;
  unit_price_sen?: number | string | null;
  discount_sen?: number | string | null;
  line_total_sen?: number | string | null;
};

export type PiExportLineContext = {
  /** The GRN line's supplier SKU, via grn_item_id (the invoice line has none). */
  supplierSku: string | null;
  /** AutoCount's short location code (`KL`) for the GRN header's warehouse. */
  location: string | null;
  /** The goods-received note the line bills, via grn_item_id. */
  grnNo: string | null;
  /** The PO of that GRN line, via its purchase_order_item_id. */
  poNo: string | null;
  /** The sales order that PO line was raised for, via its so_item_id. */
  soDocNo: string | null;
  /** Today in Malaysia, YYYY-MM-DD — the day Overdue Days counts to. */
  today: string;
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

/** What the invoice still owes, in sen — the list's Owed rule: total − paid,
 *  floored at 0. */
export function piBalanceSen(h: Pick<PiExportHeader, 'total_sen' | 'paid_sen'>): number {
  return Math.max(0, (num(h.total_sen) ?? 0) - (num(h.paid_sen) ?? 0));
}

/* Whole days from the STORED due date to today, while something is owed.
   Blank when there is no due date: owner 2026-09-15, a due date is never
   derived from the supplier's credit term. Not yet due reads 0. */
export function overdueDays(dueDate: string | null | undefined, today: string, balanceSen: number): number | null {
  const due = isoDate(dueDate);
  if (!due || balanceSen <= 0) return null;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function piLineExportCells(
  header: PiExportHeader,
  line: PiExportLine,
  ctx: PiExportLineContext,
): PiLineExportCell[] {
  const balanceSen = piBalanceSen(header);
  const byColumn: Record<PiLineExportColumn, PiLineExportCell> = {
    'Doc No': text(header.invoice_number),
    'AutoCount Doc No': text(header.linked_ac_docno),
    'Doc Date': isoDate(header.invoice_date),
    'Status': piStatusWord(header.status, header.on_hold),
    'Supplier Code': text(header.supplier?.code),
    'Supplier Name': text(header.supplier?.name),
    'Supplier Invoice No.': text(header.supplier_invoice_ref),
    'Item Code': text(line.item_code),
    'Supplier SKU': text(ctx.supplierSku),
    'Item Description': text(line.material_name) ?? text(line.description),
    'Item Description 2': text(line.description2),
    'Remarks': text(line.notes),
    'Category': text(line.item_group),
    'Location': text(ctx.location),
    'UOM': text(line.uom),
    'Qty': num(line.qty) ?? 0,
    'Currency': text(header.currency),
    'PO Unit Price': ringgit(line.po_unit_price_sen, 4),
    'Unit Price': ringgit(line.unit_price_sen, 4),
    'Discount': ringgit(line.discount_sen, 2),
    'Line Total': ringgit(line.line_total_sen, 2),
    'Invoice Total': ringgit(header.total_sen, 2),
    'Balance': ringgit(balanceSen, 2),
    'Due Date': isoDate(header.due_date),
    'Overdue Days': overdueDays(header.due_date, ctx.today, balanceSen),
    'GRN No.': text(ctx.grnNo),
    'PO No.': text(ctx.poNo),
    'SO Doc No.': text(ctx.soDocNo),
    'Line ID': line.id,
  };
  return PI_LINE_EXPORT_COLUMNS.map((col) => byColumn[col]);
}
