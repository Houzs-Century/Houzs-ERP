/* The Goods Received list's two exports — every receipt the list's CURRENT tab,
   search and sort match, across all pages (owner 2026-09-15).

   The server does the reading (GET /grns/export/lines and /export/headers,
   backend routes/grn-exports.ts) through the list's own filter. This module
   sends the SAME parameters the list sends (grnListParams is also what
   useGrnsPaged builds its request from) and writes the file. */

import { authedFetch } from './authed-fetch';
import { ExportTruncatedError } from './po-list-export';
import { checkLineExportBody, fetchByIdChunks, writeLineExportXlsx, type LineExportBody } from './line-export-file';
import { applyListMrpEnrichment, type EnrichableMrpRow, type ListMrpEnrichment } from '../../../lib/listMrpEnrichment';
import { GRN_LINE_EXPORT_COLUMNS, GRN_LINE_EXPORT_NUMBER_FORMATS } from './grn-line-export-columns';

export type GrnListFilterParams = { status?: string; supplierId?: string; q?: string; sort?: string };

/** The list's filter as query parameters — no paging. */
export function grnListParams(f: GrnListFilterParams): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.supplierId) usp.set('supplierId', f.supplierId);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  return usp;
}

const withQuery = (path: string, usp: URLSearchParams) => (usp.toString() ? `${path}?${usp.toString()}` : path);

export type GrnLineExportBody = LineExportBody & { grnCount: number };

export async function fetchGrnLineExport(f: GrnListFilterParams): Promise<GrnLineExportBody> {
  const body = await authedFetch<GrnLineExportBody>(withQuery('/grns/export/lines', grnListParams(f)));
  return checkLineExportBody(body, GRN_LINE_EXPORT_COLUMNS, 'goods received notes');
}

export function writeGrnLineExportXlsx(body: GrnLineExportBody, fileName: string): Promise<void> {
  return writeLineExportXlsx(GRN_LINE_EXPORT_COLUMNS, GRN_LINE_EXPORT_NUMBER_FORMATS, body.rows, 'GRN Lines', fileName);
}

/* The server's cap on ids per enrichment request (MAX_IDS in
   routes/grns-list-enrichment.ts). Each request runs one company-wide MRP, so
   they go two at a time. */
const ENRICH_CHUNK = 200;
const ENRICH_CONCURRENCY = 2;

/**
 * Every receipt the list's filters match, in the list's own row shape. When
 * `withMrpColumns` is set, Assigned SO / Delivered are healed exactly as the
 * screen heals them, so the exported cells match the grid.
 */
export async function fetchAllGrnListRows<T extends EnrichableMrpRow & { id: string }>(
  f: GrnListFilterParams,
  withMrpColumns: boolean,
): Promise<T[]> {
  const body = await authedFetch<{ grns?: T[]; total: number; truncated: boolean }>(withQuery('/grns/export/headers', grnListParams(f)));
  if (body.truncated) throw new ExportTruncatedError('goods received notes');
  const rows = body.grns ?? [];
  if (!withMrpColumns || rows.length === 0) return rows;
  const byId = await fetchByIdChunks<ListMrpEnrichment>(rows.map((r) => r.id), ENRICH_CHUNK, ENRICH_CONCURRENCY, async (chunk) =>
    (await authedFetch<{ enrichment?: Record<string, ListMrpEnrichment> }>(
      `/grns/list-mrp-enrichment?grnIds=${encodeURIComponent(chunk.join(','))}`,
    )).enrichment);
  return rows.map((r) => applyListMrpEnrichment(r, byId.get(r.id)));
}
