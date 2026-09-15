/* The Purchase Order list's two exports — every order the list's CURRENT tab,
   search and sort match, across all pages (owner 2026-09-15).

   The server does the reading (GET /mfg-purchase-orders/export/lines and
   /export/headers, backend routes/purchase-order-exports.ts) through the list's
   own filter. This module owns the other half: sending the SAME parameters the
   list sends (poListParams is also what usePurchaseOrdersPaged builds its
   request from), and writing the file.

   A read the server had to stop is REFUSED here, never written: a short file
   that looks complete is exactly the defect these exports replace. */

import { authedFetch } from './authed-fetch';
import { applyListMrpEnrichment, type EnrichableMrpRow, type ListMrpEnrichment } from '../../../lib/listMrpEnrichment';
import {
  PO_LINE_EXPORT_COLUMNS,
  PO_LINE_EXPORT_NUMBER_FORMATS,
  type PoLineExportCell,
  type PoLineExportColumn,
} from './po-line-export-columns';

export type PoListFilterParams = { status?: string; supplierId?: string; q?: string; sort?: string };

/** The list's filter as query parameters — no paging. */
export function poListParams(f: PoListFilterParams): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.supplierId) usp.set('supplierId', f.supplierId);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  return usp;
}

const withQuery = (path: string, usp: URLSearchParams) => (usp.toString() ? `${path}?${usp.toString()}` : path);

export type PoLineExportBody = {
  columns: string[];
  rows: PoLineExportCell[][];
  poCount: number;
  lineCount: number;
  truncated: boolean;
};

export class ExportTruncatedError extends Error {
  constructor(what: string) {
    super(`More ${what} match these filters than one export can hold, so no file was written. Narrow the tab or the search and export again.`);
    this.name = 'ExportTruncatedError';
  }
}

export async function fetchPoLineExport(f: PoListFilterParams): Promise<PoLineExportBody> {
  const body = await authedFetch<PoLineExportBody>(withQuery('/mfg-purchase-orders/export/lines', poListParams(f)));
  if (body.truncated) throw new ExportTruncatedError('purchase orders');
  /* The header row IS the import contract. A server that answers with other
     columns (an older or newer deployment) must not produce a file an import
     would then misread. */
  if (body.columns.join('|') !== PO_LINE_EXPORT_COLUMNS.join('|')) {
    throw new Error('The server sent a different set of export columns than this page expects. Reload the page and export again.');
  }
  return body;
}

export async function writePoLineExportXlsx(body: PoLineExportBody, fileName: string): Promise<void> {
  const XLSX = await import('../../../lib/xlsx-runtime');
  const aoa: PoLineExportCell[][] = [[...PO_LINE_EXPORT_COLUMNS], ...body.rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa) as Record<string, unknown>;
  PO_LINE_EXPORT_COLUMNS.forEach((col: PoLineExportColumn, c) => {
    const fmt = PO_LINE_EXPORT_NUMBER_FORMATS[col];
    if (!fmt) return;
    for (let r = 1; r <= body.rows.length; r += 1) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as { t?: string; z?: string } | undefined;
      if (cell && cell.t === 'n') cell.z = fmt;
    }
  });
  ws['!cols'] = PO_LINE_EXPORT_COLUMNS.map((col) => ({ wch: Math.min(42, Math.max(10, col.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PO Lines');
  XLSX.writeFileXLSX(wb, fileName);
}

/* The server's cap on ids per enrichment request (MAX_IDS in
   routes/mfg-purchase-orders-list-enrichment.ts). Each request runs one
   company-wide MRP, so they go two at a time, not all at once. */
const ENRICH_CHUNK = 200;
const ENRICH_CONCURRENCY = 2;

/**
 * Every PO row the list's filters match, in the list's own row shape. When
 * `withMrpColumns` is set, the MRP-derived columns (Assigned SO / Delivered) are
 * healed exactly as the screen heals them, so the exported cells match the grid.
 */
export async function fetchAllPoListRows<T extends EnrichableMrpRow & { id: string }>(
  f: PoListFilterParams,
  withMrpColumns: boolean,
): Promise<T[]> {
  const body = await authedFetch<{ purchaseOrders: T[]; total: number; truncated: boolean }>(
    withQuery('/mfg-purchase-orders/export/headers', poListParams(f)),
  );
  if (body.truncated) throw new ExportTruncatedError('purchase orders');
  const rows = body.purchaseOrders ?? [];
  if (!withMrpColumns || rows.length === 0) return rows;

  const ids = rows.map((r) => r.id);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += ENRICH_CHUNK) chunks.push(ids.slice(i, i + ENRICH_CHUNK));
  const byId = new Map<string, ListMrpEnrichment>();
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++]!;
      const res = await authedFetch<{ enrichment: Record<string, ListMrpEnrichment> }>(
        `/mfg-purchase-orders/list-mrp-enrichment?poIds=${encodeURIComponent(chunk.join(','))}`,
      );
      for (const [k, v] of Object.entries(res.enrichment ?? {})) byId.set(k, v);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, chunks.length) }, worker));
  return rows.map((r) => applyListMrpEnrichment(r, byId.get(r.id)));
}
