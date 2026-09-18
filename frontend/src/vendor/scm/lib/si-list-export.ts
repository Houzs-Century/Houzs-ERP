/* The Sales Invoices list's ONE export — every invoice the list's CURRENT tab,
   search and sort match, across all pages, one row per line with the grid's
   visible columns (owner 2026-09-15: "exactly like AutoCount"). The server
   applies the caller's sales scope exactly as the list does.

   The server reads (GET /sales-invoices/export/rows, backend
   routes/sales-invoice-exports.ts) through the list's own filter, stamps the
   list's derived header columns and attaches each invoice's lines with the same
   function the list page uses (lib/si-export-rows.ts attachSiLines). DataTable
   `exportLines` applies the grid's funnels and sort and writes the file. */

import { authedFetch } from './authed-fetch';
import { ExportTruncatedError } from './po-list-export';
import { senToRinggit } from './grn-list-export';

export { senToRinggit };

export type SiListFilterParams = { status?: string; q?: string; sort?: string; debtorNames?: string[]; currencies?: string[] };

/** The list's filter as query parameters — no paging. */
export function siListParams(f: SiListFilterParams): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  // Server-filterable column funnels (owner 2026-09-16): Customer Name /
  // Currency, JSON arrays (a customer name may contain a comma).
  if (f.debtorNames && f.debtorNames.length) usp.set('debtorNames', JSON.stringify(f.debtorNames));
  if (f.currencies && f.currencies.length) usp.set('currencies', JSON.stringify(f.currencies));
  return usp;
}

const withQuery = (path: string, usp: URLSearchParams) => (usp.toString() ? `${path}?${usp.toString()}` : path);

/** One invoice line as GET /sales-invoices (paged) and /export/rows carry it. Money in sen. */
export type SiListLine = {
  id: string;
  item_code: string | null;
  ac_item_code: string | null;
  book_description: string | null;
  book_item_group: string | null;
  book_uom: string | null;
  description: string | null;
  description2: string | null;
  remarks: string | null;
  item_group: string | null;
  uom: string | null;
  location: string | null;
  qty: number;
  unit_price_sen: number | null;
  discount_sen: number | null;
  line_total_sen: number | null;
  delivery_date: string | null;
  do_no: string | null;
};

/* AutoCount's Sales Invoice Detail Listing captions, read from the company's
   saved layouts of FormInvoicePrintDetailListing on 2026-09-15. The book keeps
   no DEFAULT layout for it (only a staff layout, "Chew"), so the default set is
   the Goods Received / Purchase Invoice defaults' shape with the sales captions
   — LIKELY AutoCount's factory default, not read from the book. */
export const SI_LABELS = {
  docNo: 'Doc No',
  docDate: 'Doc Date',
  debtorCode: 'Debtor Code',
  debtorName: 'Debtor Name',
  agent: 'Agent',
  currCode: 'Curr. Code',
  currRate: 'Curr. Rate',
  inclusive: 'Inclusive?',
  subTotalEx: 'SubTotal (ex)',
  tax: 'Tax',
  total: 'Total',
  localTotal: 'Local Total',
  cancelled: 'Cancelled',
  itemCode: 'Item Code',
  detailDescription: 'Detail Description',
  detailDescription2: 'Detail Description 2',
  uom: 'UOM',
  location: 'Location',
  projNo: 'Proj No',
  qty: 'Qty',
  unitPrice: 'Unit Price',
  discount: 'Discount',
  lineTotal: 'Total',
  taxCode: 'Tax Code',
  lineTax: 'Tax',
  totalEx: 'Total (Ex)',
  totalInc: 'Total (Inc)',
  desc2: 'Desc2',
  itemGroup: 'Item Group',
  deliveryDate: 'Delivery Date',
  ref: 'Ref',
  erpDocNo: 'ERP Doc No',
  erpItemCode: 'ERP Item Code',
  doNo: 'DO No.',
  remarks: 'Remarks',
  lineId: 'Line ID',
} as const;

/** AutoCount's Sales Invoice Detail Listing columns, in its order — offered in
 *  the grid's column chooser, HIDDEN by default. Owner 2026-09-15 「默认跟我的data
 *  grid啊」: a fresh Sales Invoices grid keeps its own columns; staff tick these
 *  on to export AutoCount's shape. Keys the list already has (Doc Date, Debtor
 *  Code / Name, Total) stay the list's own column. ONE constant. */
export const SI_AC_COLUMN_KEYS = [
  'ac_doc_no', 'invoice_date', 'debtor_code', 'debtor_name', 'agent', 'currency', 'exchange_rate', 'inclusive',
  'subtotal', 'tax', 'amount', 'local_total', 'cancelled', 'item_code', 'detail_description', 'detail_description_2',
  'uom', 'location', 'proj_no', 'qty', 'unit_price', 'discount', 'line_total', 'tax_code', 'line_tax', 'total_ex',
  'total_inc', 'desc2',
] as const;

/** Every invoice the list's filters match, in the list's row shape (stamped and
 *  finance-gated by the server), each with its `lines`. THROWS on a stopped read. */
export async function fetchSiExportRows<T extends { id: string; lines?: SiListLine[] }>(
  f: SiListFilterParams,
  _need: { exportKeys: string[]; filterKeys: string[] },
): Promise<T[]> {
  const body = await authedFetch<{ salesInvoices?: T[]; total: number; truncated: boolean }>(
    withQuery('/sales-invoices/export/rows', siListParams(f)),
  );
  if (body.truncated) throw new ExportTruncatedError('sales invoices');
  return body.salesInvoices ?? [];
}
