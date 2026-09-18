/* The Sales Order and Delivery Order lists' ONE export — every document the
   list's CURRENT tab, search, filters and sort match, across all pages, each with
   its lines (owner 2026-09-15).

   The server (backend routes/sales-order-exports.ts, delivery-order-exports.ts)
   reads through the list's own filter, company and sales scope and attaches the
   lines with the same function the list page uses. It answers in WINDOWS of at
   most 500 documents (`next` = the offset to ask for next), because one request
   for a whole list went over the Worker's subrequest cap; this module asks until
   there is no next window. DataTable `exportLines` then applies the grid's
   funnels and sort and writes one row per line. A listing larger than one export
   holds is REFUSED — a short file that looks complete is exactly the defect this
   replaces. */

import { authedFetch } from './authed-fetch';
import { ExportTruncatedError } from './po-list-export';
import { soListSearchParams } from './sales-order-queries';
import { doListSearchParams } from './delivery-order-queries';
import type { SoListFilter } from '../../shared/so-list-filter-model';

/** The most documents one export file holds — the ceiling the other list exports use. */
export const EXPORT_MAX_DOCUMENTS = 20_000;

type WindowBody<K extends string, T> = { [key in K]?: T[] } & { total: number; lineCount: number; next: number | null };

async function readWindows<K extends string, T>(path: string, usp: URLSearchParams, key: K, idOf: (row: T) => string, what: string): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let offset: number | null = 0;
  while (offset !== null) {
    const q = new URLSearchParams(usp);
    q.set('offset', String(offset));
    const body: WindowBody<K, T> = await authedFetch<WindowBody<K, T>>(`${path}?${q.toString()}`);
    /* A document added while the export runs shifts the later windows by one;
       the repeat it causes is dropped here. */
    for (const row of body[key] ?? []) {
      const id = idOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(row);
    }
    if (body.next !== null && body.next <= offset) throw new Error('The export server answered out of order. Export again.');
    if (body.next !== null && out.length >= EXPORT_MAX_DOCUMENTS) throw new ExportTruncatedError(what);
    offset = body.next;
  }
  return out;
}

export function fetchSoExportRows<T extends { doc_no: string }>(f: { status?: string; q?: string; sort?: string; filters?: readonly SoListFilter[] }): Promise<T[]> {
  return readWindows('/mfg-sales-orders/export/rows', soListSearchParams(f), 'salesOrders', (r: T) => r.doc_no, 'sales orders');
}

export function fetchDoExportRows<T extends { id: string }>(f: { status?: string; q?: string; sort?: string }): Promise<T[]> {
  return readWindows('/delivery-orders-mfg/export/rows', doListSearchParams(f), 'deliveryOrders', (r: T) => r.id, 'delivery orders');
}
