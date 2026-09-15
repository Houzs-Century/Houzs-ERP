/* The Sales Order LINE export — one row per sales order line (owner
   2026-09-15), the column design in docs/line-export-columns.md §1.

   THIS FILE IS A CONTRACT, not a formatting detail. The export's header names
   and its "Line ID" column are what a future import reads back: rows are
   matched by Line ID and only Delivery Date, Item Description 2 and Remarks
   are written. Rename one of those here and every file already exported stops
   importing.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/so-line-export-columns.ts
   (the frontend writes the sheet, the server builds the rows). Refereed by
   frontend/src/vendor/scm/lib/so-line-export-columns.canonical.test.ts and by
   backend/scripts/check-shared-mirrors.mjs. No imports, so the two copies can
   stay identical. */

export const SO_LINE_EXPORT_COLUMNS = [
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
  'Delivered Qty',
  'Returned Qty',
  'Remaining Qty',
  'On Delivery Order Qty',
  'Stock Status',
  'Unit Price',
  'Discount',
  'Line Total',
  'Doc Balance',
  'Delivery Date',
  'Processing Date',
  'Salesperson',
  'Branding',
  'Venue',
  'Sales Location',
  'Phone',
  'Delivery Address',
  'State',
  'DO No.',
  'PO No.',
  'PO Delivery Date',
  'Line ID',
] as const;

export type SoLineExportColumn = (typeof SO_LINE_EXPORT_COLUMNS)[number];
export type SoLineExportCell = string | number | null;

/* A money cell is a NUMBER in ringgit, so the sheet can sum it; the format only
   controls how many decimals show. A unit price is a rate and keeps up to four. */
export const SO_LINE_EXPORT_NUMBER_FORMATS: Partial<Record<SoLineExportColumn, string>> = {
  'Qty': '0.##',
  'Delivered Qty': '0.##',
  'Returned Qty': '0.##',
  'Remaining Qty': '0.##',
  'On Delivery Order Qty': '0.##',
  'Unit Price': '#,##0.00##',
  'Discount': '#,##0.00',
  'Line Total': '#,##0.00',
  'Doc Balance': '#,##0.00',
};

/* The word the Sales Orders LIST pill shows for each stored status — the label
   half of STATUS_TONE in frontend/src/pages/scm-v2/so-list-status.ts, keyed by
   the stored value. This file's canonical test asserts the two say the same
   words. */
export const SO_STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  CONFIRMED: 'Submitted',
  CANCELLED: 'Cancelled',
  CANCEL: 'Cancelled',
  INVOICED: 'Invoiced',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CLOSED: 'Closed',
  IN_PRODUCTION: 'In Production',
  READY_TO_SHIP: 'Ready to Ship',
  SHIPPED: 'Shipped',
  ON_HOLD: 'On Hold',
};

export type SoDeliveryState = 'none' | 'partial' | 'full';
export type SoLifecycleState = 'none' | 'delivered' | 'invoiced' | 'returned';

/* The statuses whose stored word stands whatever the delivery records say —
   soStatusDisplay's TERMINAL set (frontend/src/vendor/scm/lib/so-status.ts). */
const SO_TERMINAL = ['CANCELLED', 'CLOSED', 'ON_HOLD'];

/**
 * The word the Sales Orders list pill shows for one order: the stored status,
 * unless the order's own delivery records say more (Partially Delivered,
 * Delivered, Invoiced, Delivery Return) — soRowStatus over soStatusDisplay, the
 * rule the list and the detail page both render. A held order says so after
 * the word, once. The canonical test runs this against the list's own functions
 * for every combination.
 */
export function soListStatusWord(
  status: string | null | undefined,
  deliveryState: SoDeliveryState | null,
  lifecycleState: SoLifecycleState | null,
  onHold: boolean | null,
): string | null {
  const raw = (status ?? '').trim();
  if (!raw) return null;
  const stored = SO_STATUS_WORDS[raw.toUpperCase()] ?? raw;
  let word = stored;
  if (!SO_TERMINAL.includes(raw)) {
    if (lifecycleState === 'returned') word = 'Delivery Return';
    else if (lifecycleState === 'invoiced') word = 'Invoiced';
    else if (lifecycleState === 'delivered') word = deliveryState === 'partial' ? 'Partially Delivered' : 'Delivered';
    else if (deliveryState === 'partial') word = 'Partially Delivered';
    else if (deliveryState === 'full') word = 'Delivered';
  }
  return onHold === true && raw.toUpperCase() !== 'ON_HOLD' ? `${word} (On Hold)` : word;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Salesperson cell, by the list's own rule (useStaffLookup nameOf): the
 * header's `agent` text when it is a name, else the staff row the salesperson
 * id names, else the staff row an `agent` that holds a uuid names.
 */
export function soSalespersonName(
  agent: string | null | undefined,
  salespersonId: string | null | undefined,
  staffName: (id: string) => string | null,
): string | null {
  const a = (agent ?? '').trim();
  if (a && !UUID_RE.test(a)) return a;
  if (salespersonId) {
    const n = (staffName(salespersonId) ?? '').trim();
    if (n) return n;
  }
  if (a) {
    const n = (staffName(a) ?? '').trim();
    if (n) return n;
  }
  return null;
}

export type SoExportHeader = {
  doc_no: string;
  so_date: string | null;
  status: string | null;
  on_hold?: boolean | null;
  debtor_code: string | null;
  debtor_name: string | null;
  ref?: string | null;
  customer_so_no?: string | null;
  branding?: string | null;
  venue?: string | null;
  sales_location?: string | null;
  phone?: string | null;
  address1?: string | null;
  address2?: string | null;
  address3?: string | null;
  address4?: string | null;
  customer_state?: string | null;
  customer_delivery_date?: string | null;
  processing_date?: string | null;
  balance_sen_live?: number | string | null;
  balance_sen?: number | string | null;
};

export type SoExportLine = {
  id: string;
  item_code: string | null;
  description: string | null;
  description2?: string | null;
  remark?: string | null;
  item_group?: string | null;
  uom?: string | null;
  qty: number | string | null;
  stock_status?: string | null;
  unit_price_sen?: number | string | null;
  discount_sen?: number | string | null;
  total_sen?: number | string | null;
  line_delivery_date?: string | null;
};

export type SoExportLineContext = {
  /** The AutoCount document number — a base-table column the list's view does not carry. */
  acDocNo: string | null;
  /** delivery_address1..4 — base-table columns the list's view does not carry. */
  deliveryAddress: [string | null, string | null, string | null, string | null];
  /** The status word, resolved by the server with soListStatusWord. */
  statusWord: string | null;
  /** AutoCount's short location code (`KL`) for the line's warehouse. */
  location: string | null;
  salesperson: string | null;
  /** The app's own delivery reading (soDeliverableRemaining). Null when the
   *  line is not in it — a cancelled line owes nothing and is not measured. */
  delivered: number | null;
  returned: number | null;
  remaining: number | null;
  /** Σ qty on delivery orders not yet shipped (a DRAFT), linked to this line. */
  onDeliveryOrder: number;
  doNos: string[];
  poNos: string[];
  poDeliveryDate: string | null;
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

/* Stored in sen; exported in ringgit. `places` rounds away float noise only. */
const ringgit = (sen: number | string | null | undefined, places: number): number | null => {
  const n = num(sen);
  if (n === null) return null;
  return Number((n / 100).toFixed(places));
};

const joined = (parts: ReadonlyArray<string | null | undefined>): string | null =>
  text(parts.map((p) => text(p)).filter((p): p is string => !!p).join(', '));

/** The customer's own reference, by the screens' rule (lib/customer-ref.ts):
 *  `ref` leads, `customer_so_no` is the fallback. */
export function soCustomerRef(h: { ref?: string | null; customer_so_no?: string | null }): string | null {
  return text(h.ref) ?? text(h.customer_so_no);
}

export function soLineExportCells(
  header: SoExportHeader,
  line: SoExportLine,
  ctx: SoExportLineContext,
): SoLineExportCell[] {
  const byColumn: Record<SoLineExportColumn, SoLineExportCell> = {
    'Doc No': text(header.doc_no),
    'AutoCount Doc No': text(ctx.acDocNo),
    'Doc Date': isoDate(header.so_date),
    'Status': ctx.statusWord,
    'Customer Code': text(header.debtor_code),
    'Customer Name': text(header.debtor_name),
    'Customer Ref': soCustomerRef(header),
    'Item Code': text(line.item_code),
    'Item Description': text(line.description),
    'Item Description 2': text(line.description2),
    'Remarks': text(line.remark),
    'Category': text(line.item_group),
    'Location': text(ctx.location),
    'UOM': text(line.uom),
    'Qty': num(line.qty) ?? 0,
    'Delivered Qty': ctx.delivered,
    'Returned Qty': ctx.returned,
    'Remaining Qty': ctx.remaining,
    'On Delivery Order Qty': ctx.onDeliveryOrder,
    'Stock Status': text(line.stock_status),
    'Unit Price': ringgit(line.unit_price_sen, 4),
    'Discount': ringgit(line.discount_sen, 2),
    'Line Total': ringgit(line.total_sen, 2),
    /* The list's Balance: the view's live balance (total − Σ payments). The
       stored balance_sen is the gross total, rewritten on every edit, and is
       only the fallback for a row the view could not compute. */
    'Doc Balance': ringgit(header.balance_sen_live ?? header.balance_sen, 2),
    'Delivery Date': isoDate(line.line_delivery_date) ?? isoDate(header.customer_delivery_date),
    'Processing Date': isoDate(header.processing_date),
    'Salesperson': text(ctx.salesperson),
    'Branding': text(header.branding),
    'Venue': text(header.venue),
    'Sales Location': text(header.sales_location),
    'Phone': text(header.phone),
    'Delivery Address': joined(ctx.deliveryAddress) ?? joined([header.address1, header.address2, header.address3, header.address4]),
    'State': text(header.customer_state),
    'DO No.': text(ctx.doNos.join(', ')),
    'PO No.': text(ctx.poNos.join(', ')),
    'PO Delivery Date': isoDate(ctx.poDeliveryDate),
    'Line ID': line.id,
  };
  return SO_LINE_EXPORT_COLUMNS.map((col) => byColumn[col]);
}
