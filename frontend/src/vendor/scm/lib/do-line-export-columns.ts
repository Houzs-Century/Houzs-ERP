/* The Delivery Order LINE export — one row per delivery order line (owner
   2026-09-15), the column design in docs/line-export-columns.md §2.

   NO PRICES, NO AMOUNTS (owner 2026-09-15): this file goes to drivers, 3PLs
   and customers. The design's Unit Price / Discount / Line Total are left out,
   and the canonical test fails if a money column comes back. Driver and
   Vehicle stay although every delivery order has them empty today (owner
   2026-09-15) — the delivery module will fill them.

   THIS FILE IS A CONTRACT, not a formatting detail. The export's header names
   and its "Line ID" column are what a future import reads back: rows are
   matched by Line ID and only Delivery Date, Item Description 2 and Remarks
   are written. Rename one of those here and every file already exported stops
   importing.

   MIRRORED, byte for byte, at frontend/src/vendor/scm/lib/do-line-export-columns.ts
   (the frontend writes the sheet, the server builds the rows). Refereed by
   frontend/src/vendor/scm/lib/do-line-export-columns.canonical.test.ts and by
   backend/scripts/check-shared-mirrors.mjs. No imports, so the two copies can
   stay identical. */

export const DO_LINE_EXPORT_COLUMNS = [
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
  'Invoiced Qty',
  'Returned Qty',
  'Uninvoiced Qty',
  'm³',
  'Delivery Date',
  'Expected Delivery',
  'Delivered On',
  'Salesperson',
  'Branding',
  'Venue',
  'Driver',
  'Vehicle',
  'Phone',
  'Delivery Address',
  'State',
  'SO Doc No.',
  'Invoice No.',
  'Line ID',
] as const;

export type DoLineExportColumn = (typeof DO_LINE_EXPORT_COLUMNS)[number];
export type DoLineExportCell = string | number | null;

export const DO_LINE_EXPORT_NUMBER_FORMATS: Partial<Record<DoLineExportColumn, string>> = {
  'Qty': '0.##',
  'Invoiced Qty': '0.##',
  'Returned Qty': '0.##',
  'Uninvoiced Qty': '0.##',
  'm³': '0.###',
};

/* The word the Delivery Orders LIST pill shows for each stored status — the
   label half of STATUS_TONE in frontend/src/pages/scm-v2/do-list-status.ts,
   keyed by the stored value. This file's canonical test asserts the two say the
   same words. LOADED reads "Confirmed" and DISPATCHED "Loaded" on screen, so
   they do here. */
export const DO_STATUS_WORDS: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  LOADED: 'Confirmed',
  DISPATCHED: 'Loaded',
  IN_TRANSIT: 'In transit',
  SIGNED: 'Delivered',
  DELIVERED: 'Delivered',
  INVOICED: 'Invoiced',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  CANCEL: 'Cancelled',
};

export function doStatusWord(status: string | null | undefined, onHold: boolean | null): string | null {
  const raw = (status ?? '').trim();
  if (!raw) return null;
  const word = DO_STATUS_WORDS[raw.toUpperCase()] ?? raw;
  return onHold === true ? `${word} (On Hold)` : word;
}

export type DoExportHeader = {
  do_number: string | null;
  linked_ac_docno?: string | null;
  do_date: string | null;
  status: string | null;
  on_hold?: boolean | null;
  debtor_code: string | null;
  debtor_name: string | null;
  ref?: string | null;
  customer_so_no?: string | null;
  so_doc_no?: string | null;
  customer_delivery_date?: string | null;
  expected_delivery_at?: string | null;
  branding?: string | null;
  venue?: string | null;
  driver_name?: string | null;
  vehicle?: string | null;
  phone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  postcode?: string | null;
  state?: string | null;
};

export type DoExportLine = {
  id: string;
  item_code: string | null;
  description: string | null;
  description2?: string | null;
  notes?: string | null;
  item_group?: string | null;
  uom?: string | null;
  qty: number | string | null;
  m3_milli?: number | string | null;
  line_delivery_date?: string | null;
};

export type DoExportLineContext = {
  /** AutoCount's short location code (`KL`) for the delivery warehouse. */
  location: string | null;
  salesperson: string | null;
  /** The app's own Pending ledger (lib/do-line-remaining.ts). Null when the
   *  delivery order is outside it — a DRAFT is not billable yet and a
   *  CANCELLED one delivered nothing. */
  invoiced: number | null;
  returned: number | null;
  uninvoiced: number | null;
  /** The Malaysian calendar day the delivery order was marked delivered. */
  deliveredOn: string | null;
  /** The Sales Order the line was raised from (via so_item_id), else the header's. */
  soDocNo: string | null;
  invoiceNos: string[];
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

const isoDate = (v: string | null | undefined): string | null => {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : s;
};

const joined = (parts: ReadonlyArray<string | null | undefined>): string | null =>
  text(parts.map((p) => text(p)).filter((p): p is string => !!p).join(', '));

export function doLineExportCells(
  header: DoExportHeader,
  line: DoExportLine,
  ctx: DoExportLineContext,
): DoLineExportCell[] {
  const m3 = num(line.m3_milli);
  const byColumn: Record<DoLineExportColumn, DoLineExportCell> = {
    'Doc No': text(header.do_number),
    'AutoCount Doc No': text(header.linked_ac_docno),
    'Doc Date': isoDate(header.do_date),
    'Status': doStatusWord(header.status, header.on_hold ?? null),
    'Customer Code': text(header.debtor_code),
    'Customer Name': text(header.debtor_name),
    /* The screens' rule (lib/customer-ref.ts): `ref` leads. */
    'Customer Ref': text(header.ref) ?? text(header.customer_so_no),
    'Item Code': text(line.item_code),
    'Item Description': text(line.description),
    'Item Description 2': text(line.description2),
    'Remarks': text(line.notes),
    'Category': text(line.item_group),
    'Location': text(ctx.location),
    'UOM': text(line.uom),
    'Qty': num(line.qty) ?? 0,
    'Invoiced Qty': ctx.invoiced,
    'Returned Qty': ctx.returned,
    'Uninvoiced Qty': ctx.uninvoiced,
    'm³': m3 === null ? null : Number((m3 / 1000).toFixed(3)),
    'Delivery Date': isoDate(line.line_delivery_date) ?? isoDate(header.customer_delivery_date),
    'Expected Delivery': isoDate(header.expected_delivery_at),
    'Delivered On': isoDate(ctx.deliveredOn),
    'Salesperson': text(ctx.salesperson),
    'Branding': text(header.branding),
    'Venue': text(header.venue),
    'Driver': text(header.driver_name),
    'Vehicle': text(header.vehicle),
    'Phone': text(header.phone),
    'Delivery Address': joined([header.address1, header.address2, header.city, header.postcode]),
    'State': text(header.state),
    'SO Doc No.': text(ctx.soDocNo) ?? text(header.so_doc_no),
    'Invoice No.': text(ctx.invoiceNos.join(', ')),
    'Line ID': line.id,
  };
  return DO_LINE_EXPORT_COLUMNS.map((col) => byColumn[col]);
}
