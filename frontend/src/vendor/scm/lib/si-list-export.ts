/* The Sales Invoices list's two exports — every invoice the list's CURRENT tab,
   search and sort match, across all pages (owner 2026-09-15). The server applies
   the caller's sales scope exactly as the list does.

   The server does the reading (GET /sales-invoices/export/lines and
   /export/headers, backend routes/sales-invoice-exports.ts) through the list's
   own filter. This module sends the SAME parameters the list sends
   (siListParams is also what useSalesInvoicesPaged builds its request from) and
   writes the file. The header rows arrive already stamped (SO dates, DO number,
   source POs, the order deposit), so nothing is healed here. */

import { authedFetch } from './authed-fetch';
import { ExportTruncatedError } from './po-list-export';
import { checkLineExportBody, writeLineExportXlsx, type LineExportBody } from './line-export-file';
import { SI_LINE_EXPORT_COLUMNS, SI_LINE_EXPORT_NUMBER_FORMATS } from './si-line-export-columns';

export type SiListFilterParams = { status?: string; q?: string; sort?: string };

/** The list's filter as query parameters — no paging. */
export function siListParams(f: SiListFilterParams): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  return usp;
}

const withQuery = (path: string, usp: URLSearchParams) => (usp.toString() ? `${path}?${usp.toString()}` : path);

export type SiLineExportBody = LineExportBody & { siCount: number };

export async function fetchSiLineExport(f: SiListFilterParams): Promise<SiLineExportBody> {
  const body = await authedFetch<SiLineExportBody>(withQuery('/sales-invoices/export/lines', siListParams(f)));
  return checkLineExportBody(body, SI_LINE_EXPORT_COLUMNS, 'sales invoices');
}

export function writeSiLineExportXlsx(body: SiLineExportBody, fileName: string): Promise<void> {
  return writeLineExportXlsx(SI_LINE_EXPORT_COLUMNS, SI_LINE_EXPORT_NUMBER_FORMATS, body.rows, 'SI Lines', fileName);
}

/** Every invoice the list's filters match, in the list's own row shape. */
export async function fetchAllSiListRows<T>(f: SiListFilterParams): Promise<T[]> {
  const body = await authedFetch<{ salesInvoices?: T[]; total: number; truncated: boolean }>(
    withQuery('/sales-invoices/export/headers', siListParams(f)),
  );
  if (body.truncated) throw new ExportTruncatedError('sales invoices');
  return body.salesInvoices ?? [];
}
