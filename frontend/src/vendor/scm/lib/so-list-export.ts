/* The Sales Order and Delivery Order lists' ONE export — every document the
   list's CURRENT tab, search, filters and sort match, across all pages, each with
   its lines (owner 2026-09-15).

   The server (backend routes/sales-order-exports.ts, delivery-order-exports.ts)
   reads through the list's own filter, company and sales scope and attaches the
   lines with the same function the list page uses. DataTable `exportLines`
   applies the grid's funnels and sort and writes one row per line. This module
   owns the request: the SAME parameters the list sends, and the refusal of a
   stopped read — a short file that looks complete is exactly the defect this
   replaces. */

import { authedFetch } from './authed-fetch';
import { ExportTruncatedError } from './po-list-export';
import { soListSearchParams } from './sales-order-queries';
import { doListSearchParams } from './delivery-order-queries';
import type { SoListFilter } from '../../shared/so-list-filter-model';

type RowsBody<K extends string, T> = { [key in K]?: T[] } & { total: number; lineCount: number; truncated: boolean };

const withQuery = (path: string, usp: URLSearchParams) => (usp.toString() ? `${path}?${usp.toString()}` : path);

export async function fetchSoExportRows<T>(f: { status?: string; q?: string; sort?: string; filters?: readonly SoListFilter[] }): Promise<T[]> {
  const body = await authedFetch<RowsBody<'salesOrders', T>>(withQuery('/mfg-sales-orders/export/rows', soListSearchParams(f)));
  if (body.truncated) throw new ExportTruncatedError('sales orders');
  return body.salesOrders ?? [];
}

export async function fetchDoExportRows<T>(f: { status?: string; q?: string; sort?: string }): Promise<T[]> {
  const body = await authedFetch<RowsBody<'deliveryOrders', T>>(withQuery('/delivery-orders-mfg/export/rows', doListSearchParams(f)));
  if (body.truncated) throw new ExportTruncatedError('delivery orders');
  return body.deliveryOrders ?? [];
}
