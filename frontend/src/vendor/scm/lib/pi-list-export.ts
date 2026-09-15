/* The Purchase Invoices list's two exports — every invoice the list's CURRENT
   tab, search and sort match, across all pages (owner 2026-09-15).

   The server does the reading (GET /purchase-invoices/export/lines and
   /export/headers, backend routes/purchase-invoice-exports.ts) through the
   list's own filter. This module sends the SAME parameters the list sends
   (piListParams is also what usePurchaseInvoicesPaged builds its request from)
   and writes the file. */

import { authedFetch } from './authed-fetch';
import { ExportTruncatedError } from './po-list-export';
import { checkLineExportBody, fetchByIdChunks, writeLineExportXlsx, type LineExportBody } from './line-export-file';
import { applyPiListMrpEnrichment, type EnrichablePiRow, type PiListMrpEnrichment } from '../../../lib/piListEnrichment';
import type { PiPoPriceSummary } from './pi-list-po-price';
import { PI_LINE_EXPORT_COLUMNS, PI_LINE_EXPORT_NUMBER_FORMATS } from './pi-line-export-columns';

export type PiListFilterParams = { status?: string; q?: string; sort?: string };

/** The list's filter as query parameters — no paging. */
export function piListParams(f: PiListFilterParams): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  return usp;
}

const withQuery = (path: string, usp: URLSearchParams) => (usp.toString() ? `${path}?${usp.toString()}` : path);

export type PiLineExportBody = LineExportBody & { piCount: number };

export async function fetchPiLineExport(f: PiListFilterParams): Promise<PiLineExportBody> {
  const body = await authedFetch<PiLineExportBody>(withQuery('/purchase-invoices/export/lines', piListParams(f)));
  return checkLineExportBody(body, PI_LINE_EXPORT_COLUMNS, 'purchase invoices');
}

export function writePiLineExportXlsx(body: PiLineExportBody, fileName: string): Promise<void> {
  return writeLineExportXlsx(PI_LINE_EXPORT_COLUMNS, PI_LINE_EXPORT_NUMBER_FORMATS, body.rows, 'PI Lines', fileName);
}

/* The server's cap on ids per request (MAX_IDS in
   routes/purchase-invoices-list-enrichment.ts, both endpoints). The MRP
   enrichment runs one company-wide MRP per request, so two at a time. */
const CHUNK = 200;
const CONCURRENCY = 2;

/**
 * Every invoice the list's filters match, in the list's own row shape, plus the
 * "vs PO price" summaries the grid reads by id. The MRP columns and the price
 * summaries are fetched only when their column is being exported, exactly as
 * the screen fetches them.
 */
export async function fetchAllPiListRows<T extends EnrichablePiRow & { id: string }>(
  f: PiListFilterParams,
  want: { mrpColumns: boolean; poPrice: boolean },
): Promise<{ rows: T[]; poPriceById: Map<string, PiPoPriceSummary> }> {
  const body = await authedFetch<{ purchaseInvoices?: T[]; total: number; truncated: boolean }>(
    withQuery('/purchase-invoices/export/headers', piListParams(f)),
  );
  if (body.truncated) throw new ExportTruncatedError('purchase invoices');
  let rows = body.purchaseInvoices ?? [];
  const ids = rows.map((r) => r.id);
  if (want.mrpColumns && ids.length > 0) {
    const byId = await fetchByIdChunks<PiListMrpEnrichment>(ids, CHUNK, CONCURRENCY, async (chunk) =>
      (await authedFetch<{ enrichment?: Record<string, PiListMrpEnrichment> }>(
        `/purchase-invoices/list-mrp-enrichment?piIds=${encodeURIComponent(chunk.join(','))}`,
      )).enrichment);
    rows = rows.map((r) => applyPiListMrpEnrichment(r, byId.get(r.id)));
  }
  const poPriceById = want.poPrice && ids.length > 0
    ? await fetchByIdChunks<PiPoPriceSummary>(ids, CHUNK, CONCURRENCY, async (chunk) =>
      (await authedFetch<{ summary?: Record<string, PiPoPriceSummary> }>(
        `/purchase-invoices/list-po-price?piIds=${encodeURIComponent(chunk.join(','))}`,
      )).summary)
    : new Map<string, PiPoPriceSummary>();
  return { rows, poPriceById };
}
