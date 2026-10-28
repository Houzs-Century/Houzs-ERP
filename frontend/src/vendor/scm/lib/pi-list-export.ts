/* The Purchase Invoices list's ONE export — every invoice the list's CURRENT
   tab, search and sort match, across all pages, one row per line with the
   grid's visible columns (owner 2026-09-15: "exactly like AutoCount").

   The server reads (GET /purchase-invoices/export/rows, backend
   routes/purchase-invoice-exports.ts) through the list's own filter and
   attaches each invoice's lines with the same function the list page uses
   (lib/pi-export-rows.ts attachPiLines). DataTable `exportLines` applies the
   grid's funnels and sort and writes the file. This module owns the request —
   the SAME parameters the list sends (piListParams is also what
   usePurchaseInvoicesPaged builds from) — the line shape, and AutoCount's
   labels. */

import { authedFetch } from './authed-fetch';
import { ExportTruncatedError } from './po-list-export';
import { applyPiListMrpEnrichment, type EnrichablePiRow, type PiListMrpEnrichment } from '../../../lib/piListEnrichment';
import type { PiPoPriceSummary } from './pi-list-po-price';
import { senToRinggit } from './grn-list-export';

export { senToRinggit };

export type PiListFilterParams = { status?: string; q?: string; sort?: string; creditorNames?: string[]; creditorCodes?: string[]; currencies?: string[] };

/** The list's filter as query parameters — no paging. */
export function piListParams(f: PiListFilterParams): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  // Server-filterable column funnels (owner 2026-09-16): Creditor Name / Code /
  // Currency, JSON arrays (a creditor name may contain a comma).
  if (f.creditorNames && f.creditorNames.length) usp.set('creditorNames', JSON.stringify(f.creditorNames));
  if (f.creditorCodes && f.creditorCodes.length) usp.set('creditorCodes', JSON.stringify(f.creditorCodes));
  if (f.currencies && f.currencies.length) usp.set('currencies', JSON.stringify(f.currencies));
  return usp;
}

const withQuery = (path: string, usp: URLSearchParams) => (usp.toString() ? `${path}?${usp.toString()}` : path);

/** One invoice line as GET /purchase-invoices (paged) and /export/rows carry it. Money in sen. */
export type PiListLine = {
  id: string;
  item_code: string | null;
  ac_item_code: string | null;
  book_description: string | null;
  book_item_group: string | null;
  book_uom: string | null;
  supplier_sku: string | null;
  description: string | null;
  description2: string | null;
  remarks: string | null;
  item_group: string | null;
  uom: string | null;
  location: string | null;
  qty: number;
  po_unit_price_sen: number | null;
  unit_price_sen: number | null;
  discount_sen: number | null;
  line_total_sen: number | null;
  grn_no: string | null;
  po_no: string | null;
  our_po_no: string | null;
  so_doc_no: string | null;
};

/* AutoCount's Purchase Invoice Detail Listing captions, read from the company's
   saved default layout "SS" (FormPurchaseInvoicePrintDetailListing) on
   2026-09-15. The extras after them are this ERP's own columns. */
export const PI_LABELS = {
  docNo: 'Doc No',
  supplierInvoiceNo: 'Supplier Invoice No.',
  docDate: 'Doc Date',
  creditorCode: 'Creditor Code',
  creditorName: 'Creditor Name',
  agent: 'Agent',
  currCode: 'Curr. Code',
  currRate: 'Curr. Rate',
  inclusive: 'Inclusive?',
  subTotalEx: 'SubTotal (Ex)',
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
  taxCode: 'Detail Tax Code',
  lineTax: 'Tax',
  totalEx: 'Total (Ex)',
  totalInc: 'Total (Inc)',
  desc2: 'Desc2',
  itemGroup: 'Item Group',
  ourPoNo: 'Our PO No.',
  erpDocNo: 'ERP Doc No',
  erpItemCode: 'ERP Item Code',
  supplierSku: 'Supplier SKU',
  poUnitPrice: 'PO Unit Price',
  grnNo: 'GRN No.',
  poNo: 'PO No.',
  soDocNo: 'SO Doc No.',
  remarks: 'Remarks',
  lineId: 'Line ID',
} as const;

/** The grid's default visible columns: AutoCount layout "SS", in its order.
 *  ONE constant, so the owner changing the default is a one-line change. */
export const PI_DEFAULT_COLUMN_KEYS = [
  'invoice_number', 'supplier_invoice_ref', 'invoice_date', 'supplier_code', 'supplier', 'agent', 'currency', 'exchange_rate',
  'inclusive', 'subtotal', 'tax', 'total', 'local_total', 'cancelled', 'item_code', 'detail_description', 'detail_description_2',
  'uom', 'location', 'proj_no', 'qty', 'unit_price', 'discount', 'line_total', 'tax_code', 'line_tax', 'total_ex', 'total_inc', 'desc2',
] as const;

const CHUNK = 200;
const CONCURRENCY = 2;
const MRP_COLUMNS = new Set(['assigned_so', 'delivered']);

async function byIdChunks<V>(ids: string[], fetchChunk: (chunk: string[]) => Promise<Record<string, V> | undefined>): Promise<Map<string, V>> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const out = new Map<string, V>();
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++]!;
      for (const [k, v] of Object.entries((await fetchChunk(chunk)) ?? {})) out.set(k, v);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return out;
}

/**
 * Every invoice the list's filters match, in the list's row shape, each with its
 * `lines`. The MRP columns and the "vs PO price" marker are fetched only when
 * the file or a funnel needs them, exactly as the screen fetches them; the
 * marker rides on each row as `po_price_summary`. THROWS on a stopped read.
 */
export async function fetchPiExportRows<T extends EnrichablePiRow & { id: string; lines?: PiListLine[]; po_price_summary?: PiPoPriceSummary }>(
  f: PiListFilterParams,
  need: { exportKeys: string[]; filterKeys: string[] },
): Promise<T[]> {
  const body = await authedFetch<{ purchaseInvoices?: T[]; total: number; truncated: boolean }>(
    withQuery('/purchase-invoices/export/rows', piListParams(f)),
  );
  if (body.truncated) throw new ExportTruncatedError('purchase invoices');
  let rows = body.purchaseInvoices ?? [];
  if (rows.length === 0) return rows;
  const keys = new Set([...need.exportKeys, ...need.filterKeys]);
  const ids = rows.map((r) => r.id);
  if ([...keys].some((k) => MRP_COLUMNS.has(k))) {
    const byId = await byIdChunks<PiListMrpEnrichment>(ids, async (chunk) =>
      (await authedFetch<{ enrichment?: Record<string, PiListMrpEnrichment> }>(
        `/purchase-invoices/list-mrp-enrichment?piIds=${encodeURIComponent(chunk.join(','))}`,
      )).enrichment);
    rows = rows.map((r) => applyPiListMrpEnrichment(r, byId.get(r.id)));
  }
  if (keys.has('vs_po')) {
    const byId = await byIdChunks<PiPoPriceSummary>(ids, async (chunk) =>
      (await authedFetch<{ summary?: Record<string, PiPoPriceSummary> }>(
        `/purchase-invoices/list-po-price?piIds=${encodeURIComponent(chunk.join(','))}`,
      )).summary);
    rows = rows.map((r) => ({ ...r, po_price_summary: byId.get(r.id) }));
  }
  return rows;
}
