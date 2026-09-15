/* The Sales Invoice LINE export — one row per invoice line (owner 2026-09-15:
   every document list exports one row per line item, across every page its
   filters match). Column design: docs/line-export-columns.md §3.

   THIS FILE IS A CONTRACT, not a formatting detail. The header names and the
   "Line ID" column are what a future import reads back: rows are matched by
   Line ID and only Delivery Date, Item Description 2 and Remarks are written.
   Rename a header here and every file already exported stops importing.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/si-line-export-columns.ts
   (the frontend writes the sheet, the server builds the rows). Refereed by
   frontend/src/vendor/scm/lib/si-line-export-columns.canonical.test.ts and by
   backend/scripts/check-shared-mirrors.mjs. No imports, so the two copies can
   stay identical — the same pattern as po-line-export-columns.ts. */

/* The word the Sales Invoices LIST shows for each stored status — the export
   prints the same word (owner 2026-09-15). Keyed lower-case like the list's own
   STATUS_TONE map, which this file's canonical test reads and compares. */
export const SI_STATUS_WORDS: Readonly<Record<string, string>> = {
  draft: 'Draft',
  sent: 'Submitted',
  issued: 'Submitted',
  overdue: 'Overdue',
  partially_paid: 'Partially paid',
  partial: 'Partially paid',
  paid: 'Paid',
  completed: 'Paid',
  cancelled: 'Cancelled',
  cancel: 'Cancelled',
};

export function siStatusWord(status: string | null | undefined): string | null {
  const raw = (status ?? '').trim();
  if (!raw) return null;
  return SI_STATUS_WORDS[raw.toLowerCase()] ?? raw;
}

export const SI_LINE_EXPORT_COLUMNS = [
  'Doc No',
  'AutoCount Doc No',
  'Doc Date',
  'Status',
  'Customer Code',
  'Customer Name',
  'Customer Ref',
  'Item Code',
  'Item Description',
  'Item Description 2',
  'Remarks',
  'Category',
  'Location',
  'UOM',
  'Qty',
  'Unit Price',
  'Discount',
  'Line Total',
  'Invoice Total',
  'Paid',
  'Balance',
  'Delivery Date',
  'Due Date',
  'Overdue Days',
  'Salesperson',
  'Branding',
  'Venue',
  'Phone',
  'SO Doc No.',
  'DO No.',
  'Line ID',
] as const;

export type SiLineExportColumn = (typeof SI_LINE_EXPORT_COLUMNS)[number];
export type SiLineExportCell = string | number | null;

/* Spreadsheet number formats. A money cell is a NUMBER in ringgit, so the sheet
   can sum it; a unit price is a rate and keeps up to four decimals. */
export const SI_LINE_EXPORT_NUMBER_FORMATS: Partial<Record<SiLineExportColumn, string>> = {
  'Qty': '0.##',
  'Unit Price': '#,##0.00##',
  'Discount': '#,##0.00',
  'Line Total': '#,##0.00',
  'Invoice Total': '#,##0.00',
  'Paid': '#,##0.00',
  'Balance': '#,##0.00',
  'Overdue Days': '0',
};

export type SiExportHeader = {
  invoice_number: string | null;
  linked_ac_docno?: string | null;
  invoice_date: string | null;
  status: string | null;
  debtor_code?: string | null;
  debtor_name?: string | null;
  ref?: string | null;
  customer_so_no?: string | null;
  po_doc_no?: string | null;
  due_date?: string | null;
  total_sen?: number | string | null;
  local_total_sen?: number | string | null;
  paid_sen?: number | string | null;
  agent?: string | null;
  branding?: string | null;
  venue?: string | null;
  phone?: string | null;
  so_doc_no?: string | null;
};

export type SiExportLine = {
  id: string;
  item_code: string | null;
  description?: string | null;
  description2?: string | null;
  notes?: string | null;
  item_group?: string | null;
  uom?: string | null;
  qty: number | string | null;
  unit_price_sen?: number | string | null;
  discount_sen?: number | string | null;
  line_total_sen?: number | string | null;
  line_delivery_date?: string | null;
};

export type SiExportLineContext = {
  /** AutoCount's short location code (`KL`) — the delivery order's warehouse
   *  (the invoice has none of its own). */
  location: string | null;
  /** The delivery order the line invoices, via do_item_id. */
  doNo: string | null;
  /** staff.name of the invoice's salesperson, or null to fall back to `agent`. */
  salespersonName: string | null;
  /** The slice of the source ORDER's deposit applied to this invoice, in sen
   *  (lib/si-order-deposit.ts). REQUIRED: without it Balance over-states what
   *  the customer owes. */
  depositAppliedSen: number;
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

/** What the invoice still owes, in sen — the list's Outstanding rule
 *  (vendor/scm/lib/si-outstanding.ts): total − (paid + the order's deposit
 *  slice), floored at 0. */
export function siBalanceSen(h: Pick<SiExportHeader, 'total_sen' | 'local_total_sen' | 'paid_sen'>, depositAppliedSen: number): number {
  const total = num(h.total_sen) || num(h.local_total_sen) || 0;
  const paid = num(h.paid_sen) ?? 0;
  const deposit = Number.isFinite(depositAppliedSen) && depositAppliedSen > 0 ? depositAppliedSen : 0;
  return Math.max(0, total - paid - deposit);
}

/* Whole days from the STORED due date to today, while something is owed.
   Blank when there is no due date: owner 2026-09-15, a due date is never
   derived from the customer's credit term. Not yet due reads 0. */
export function siOverdueDays(dueDate: string | null | undefined, today: string, balanceSen: number): number | null {
  const due = isoDate(dueDate);
  if (!due || balanceSen <= 0) return null;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function siLineExportCells(
  header: SiExportHeader,
  line: SiExportLine,
  ctx: SiExportLineContext,
): SiLineExportCell[] {
  const balanceSen = siBalanceSen(header, ctx.depositAppliedSen);
  const byColumn: Record<SiLineExportColumn, SiLineExportCell> = {
    'Doc No': text(header.invoice_number),
    'AutoCount Doc No': text(header.linked_ac_docno),
    'Doc Date': isoDate(header.invoice_date),
    'Status': siStatusWord(header.status),
    'Customer Code': text(header.debtor_code),
    'Customer Name': text(header.debtor_name),
    /* The list's own reference rule (lib/customer-ref.ts customerRefOf). */
    'Customer Ref': text(header.ref) ?? text(header.customer_so_no) ?? text(header.po_doc_no),
    'Item Code': text(line.item_code),
    'Item Description': text(line.description),
    'Item Description 2': text(line.description2),
    'Remarks': text(line.notes),
    'Category': text(line.item_group),
    'Location': text(ctx.location),
    'UOM': text(line.uom),
    'Qty': num(line.qty) ?? 0,
    'Unit Price': ringgit(line.unit_price_sen, 4),
    'Discount': ringgit(line.discount_sen, 2),
    'Line Total': ringgit(line.line_total_sen, 2),
    'Invoice Total': ringgit(header.total_sen, 2),
    'Paid': ringgit(header.paid_sen, 2),
    'Balance': ringgit(balanceSen, 2),
    'Delivery Date': isoDate(line.line_delivery_date),
    'Due Date': isoDate(header.due_date),
    'Overdue Days': siOverdueDays(header.due_date, ctx.today, balanceSen),
    'Salesperson': text(ctx.salespersonName) ?? text(header.agent),
    'Branding': text(header.branding),
    'Venue': text(header.venue),
    'Phone': text(header.phone),
    'SO Doc No.': text(header.so_doc_no),
    'DO No.': text(ctx.doNo),
    'Line ID': line.id,
  };
  return SI_LINE_EXPORT_COLUMNS.map((col) => byColumn[col]);
}
