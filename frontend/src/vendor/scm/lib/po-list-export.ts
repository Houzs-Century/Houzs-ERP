/* The Purchase Order list's ONE export — every order the list's CURRENT tab,
   search and sort match, across all pages, one row per line with the grid's
   visible columns (owner 2026-09-15).

   The server reads (GET /mfg-purchase-orders/export/rows, backend
   routes/purchase-order-exports.ts) through the list's own filter and attaches
   each order's lines. DataTable `exportLines` applies the grid's funnels and
   sort to that set and writes the file. This module owns the request: the SAME
   parameters the list sends (poListParams is also what usePurchaseOrdersPaged
   builds its request from), and the refusal of a stopped read — a short file
   that looks complete is exactly the defect this replaces. */

import { authedFetch } from './authed-fetch';
import { applyListMrpEnrichment, type EnrichableMrpRow, type ListMrpEnrichment } from '../../../lib/listMrpEnrichment';
import type { PoListLine } from './po-line-export-columns';

export type PoListFilterParams = {
  status?: string;
  supplierId?: string;
  q?: string;
  sort?: string;
  /* Server-filterable column funnels (owner 2026-09-16): the Creditor Name /
     Code and Currency funnels the grid pushes down so pagination runs over the
     filtered set. Sent as JSON arrays in one param each — a creditor name may
     contain a comma. */
  creditorNames?: string[];
  creditorCodes?: string[];
  currencies?: string[];
};

/** The list's filter as query parameters — no paging. */
export function poListParams(f: PoListFilterParams): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.supplierId) usp.set('supplierId', f.supplierId);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  if (f.creditorNames && f.creditorNames.length) usp.set('creditorNames', JSON.stringify(f.creditorNames));
  if (f.creditorCodes && f.creditorCodes.length) usp.set('creditorCodes', JSON.stringify(f.creditorCodes));
  if (f.currencies && f.currencies.length) usp.set('currencies', JSON.stringify(f.currencies));
  return usp;
}

const withQuery = (path: string, usp: URLSearchParams) => (usp.toString() ? `${path}?${usp.toString()}` : path);

export class ExportTruncatedError extends Error {
  constructor(what: string) {
    super(`More ${what} match these filters than one export can hold, so no file was written. Narrow the tab or the search and export again.`);
    this.name = 'ExportTruncatedError';
  }
}

/* The server's cap on ids per enrichment request (MAX_IDS in
   routes/mfg-purchase-orders-list-enrichment.ts). Each request runs one
   company-wide MRP, so they go two at a time, not all at once. */
const ENRICH_CHUNK = 200;
const ENRICH_CONCURRENCY = 2;

/** The MRP-derived columns: only these need /list-mrp-enrichment. */
const MRP_COLUMNS = new Set(['assigned_so', 'delivered']);

/**
 * Every PO row the list's filters match, in the list's row shape, each with its
 * `lines`. The MRP-derived columns are healed exactly as the screen heals them,
 * but only when the file shows Delivered or a funnel reads an MRP column (Assigned
 * SO exports each line's own SO number and needs no MRP).
 */
export async function fetchPoExportRows<T extends EnrichableMrpRow & { id: string; lines?: PoListLine[] }>(
  f: PoListFilterParams,
  need: { exportKeys: string[]; filterKeys: string[] },
): Promise<T[]> {
  const body = await authedFetch<{ purchaseOrders?: T[]; total: number; truncated: boolean }>(
    withQuery('/mfg-purchase-orders/export/rows', poListParams(f)),
  );
  if (body.truncated) throw new ExportTruncatedError('purchase orders');
  const rows = body.purchaseOrders ?? [];
  const withMrp = need.exportKeys.includes('delivered') || need.filterKeys.some((k) => MRP_COLUMNS.has(k));
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
        `/mfg-purchase-orders/list-mrp-enrichment?poIds=${encodeURIComponent(chunk.join(','))}`,
      );
      for (const [k, v] of Object.entries(res.enrichment ?? {})) byId.set(k, v);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, chunks.length) }, worker));
  return rows.map((r) => applyListMrpEnrichment(r, byId.get(r.id)));
}
