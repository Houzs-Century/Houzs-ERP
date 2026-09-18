/* The Purchase Returns and Delivery Returns lists' ONE export — every return
   the list's server read matches, each with its lines (owner 2026-09-15).

   The server (backend routes/purchase-return-exports.ts, delivery-return-exports.ts)
   reads through the list's own filter, company and sales scope, with no screen
   cap, and attaches the lines the list rows carry. The page applies its tab and
   search to that set (those two filter in the browser on these lists) and
   DataTable `exportLines` applies the funnels and sort and writes the file.
   This module owns the request and the refusal of a stopped read — a short file
   that looks complete is exactly the defect this replaces. */

import { authedFetch } from './authed-fetch';

export class ReturnExportTruncatedError extends Error {
  constructor(what: string) {
    super(`More ${what} match these filters than one export can hold, so no file was written. Narrow the tab or the search and export again.`);
    this.name = 'ReturnExportTruncatedError';
  }
}

type ExportBody<K extends string, T> = { [key in K]?: T[] } & { total: number; lineCount: number; truncated: boolean };

export async function fetchPurchaseReturnExportRows<T>(): Promise<T[]> {
  const body = await authedFetch<ExportBody<'purchaseReturns', T>>('/purchase-returns/export/rows');
  if (body.truncated) throw new ReturnExportTruncatedError('purchase returns');
  return body.purchaseReturns ?? [];
}

export async function fetchDeliveryReturnExportRows<T>(): Promise<T[]> {
  const body = await authedFetch<ExportBody<'deliveryReturns', T>>('/delivery-returns/export/rows');
  if (body.truncated) throw new ReturnExportTruncatedError('delivery returns');
  return body.deliveryReturns ?? [];
}
