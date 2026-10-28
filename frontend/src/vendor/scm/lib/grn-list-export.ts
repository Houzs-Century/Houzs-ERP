/* The Goods Received list's ONE export — every receipt the list's CURRENT tab,
   search and sort match, across all pages, one row per line with the grid's
   visible columns (owner 2026-09-15: "exactly like AutoCount").

   The server reads (GET /grns/export/rows, backend routes/grn-exports.ts)
   through the list's own filter and attaches each receipt's lines with the same
   function the list page uses (lib/grn-export-rows.ts attachGrnLines). DataTable
   `exportLines` applies the grid's funnels and sort and writes the file. This
   module owns the request — the SAME parameters the list sends (grnListParams is
   also what useGrnsPaged builds from) — the line shape, and AutoCount's labels. */

import { authedFetch } from './authed-fetch';
import { ExportTruncatedError } from './po-list-export';
import { applyListMrpEnrichment, type EnrichableMrpRow, type ListMrpEnrichment } from '../../../lib/listMrpEnrichment';

export type GrnListFilterParams = { status?: string; supplierId?: string; q?: string; sort?: string; creditorNames?: string[]; creditorCodes?: string[]; currencies?: string[] };

/** The list's filter as query parameters — no paging. */
export function grnListParams(f: GrnListFilterParams): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.supplierId) usp.set('supplierId', f.supplierId);
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

/** One receipt line as GET /grns (paged) and /export/rows carry it. Money in sen. */
export type GrnListLine = {
  id: string;
  item_code: string | null;
  /** AutoCount's ItemCode (bookLineItem with the supplier's bindings), else ours. */
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
  qty_received: number;
  qty_rejected: number;
  invoiced_qty: number;
  returned_qty: number;
  uninvoiced_qty: number;
  unit_price_sen: number | null;
  discount_sen: number | null;
  line_total_sen: number | null;
  delivery_date: string | null;
  po_no: string | null;
  our_po_no: string | null;
  so_doc_no: string | null;
  invoice_nos: string | null;
};

/* AutoCount's Goods Received Detail Listing captions, read from the company's
   saved default layout "S" (FormGoodsReceivedNotePrintDetailListing) on
   2026-09-15. The extras after them are this ERP's own columns. */
export const GRN_LABELS = {
  docNo: 'Doc No',
  supplierDoNo: 'Supplier DO No',
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
  taxCode: 'Tax Code',
  lineTax: 'Tax',
  totalEx: 'Total (Ex)',
  totalInc: 'Total (Inc)',
  desc2: 'Desc2',
  ourPoNo: 'Our PO No.',
  itemGroup: 'Item Group',
  deliveryDate: 'Delivery Date',
  erpDocNo: 'ERP Doc No',
  erpItemCode: 'ERP Item Code',
  remarks: 'Remarks',
  invoicedQty: 'Invoiced Qty',
  returnedQty: 'Returned Qty',
  uninvoicedQty: 'Uninvoiced Qty',
  invoiceNo: 'Invoice No.',
  soDocNo: 'SO Doc No.',
  lineId: 'Line ID',
} as const;

/** The grid's default visible columns: AutoCount layout "S", in its order.
 *  ONE constant, so the owner changing the default is a one-line change. */
export const GRN_DEFAULT_COLUMN_KEYS = [
  'grn_number', 'dn', 'received_at', 'supplier_code', 'supplier', 'agent', 'currency', 'exchange_rate', 'inclusive',
  'subtotal', 'tax', 'total', 'local_total', 'cancelled', 'item_code', 'detail_description', 'detail_description_2',
  'uom', 'location', 'proj_no', 'qty', 'unit_price', 'discount', 'line_total', 'tax_code', 'line_tax', 'total_ex',
  'total_inc', 'desc2', 'our_po_no',
] as const;

/** Sen to a ringgit NUMBER (Excel sums it). `places` only trims float noise. */
export const senToRinggit = (sen: number | null | undefined, places: number): number | null =>
  sen === null || sen === undefined || !Number.isFinite(Number(sen)) ? null : Number((Number(sen) / 100).toFixed(places));

const ENRICH_CHUNK = 200;
const ENRICH_CONCURRENCY = 2;
const MRP_COLUMNS = new Set(['assigned_so', 'delivered']);

/**
 * Every receipt the list's filters match, in the list's row shape, each with its
 * `lines`. Assigned SO / Delivered are healed exactly as the screen heals them,
 * only when the file or a funnel needs one of them (each enrichment request runs
 * a company-wide MRP). THROWS on a stopped read.
 */
export async function fetchGrnExportRows<T extends EnrichableMrpRow & { id: string; lines?: GrnListLine[] }>(
  f: GrnListFilterParams,
  need: { exportKeys: string[]; filterKeys: string[] },
): Promise<T[]> {
  const body = await authedFetch<{ grns?: T[]; total: number; truncated: boolean }>(withQuery('/grns/export/rows', grnListParams(f)));
  if (body.truncated) throw new ExportTruncatedError('goods received notes');
  const rows = body.grns ?? [];
  const withMrp = need.exportKeys.some((k) => MRP_COLUMNS.has(k)) || need.filterKeys.some((k) => MRP_COLUMNS.has(k));
  if (!withMrp || rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += ENRICH_CHUNK) chunks.push(ids.slice(i, i + ENRICH_CHUNK));
  const byId = new Map<string, ListMrpEnrichment>();
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++]!;
      const res = await authedFetch<{ enrichment?: Record<string, ListMrpEnrichment> }>(
        `/grns/list-mrp-enrichment?grnIds=${encodeURIComponent(chunk.join(','))}`,
      );
      for (const [k, v] of Object.entries(res.enrichment ?? {})) byId.set(k, v);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, chunks.length) }, worker));
  return rows.map((r) => applyListMrpEnrichment(r, byId.get(r.id)));
}
