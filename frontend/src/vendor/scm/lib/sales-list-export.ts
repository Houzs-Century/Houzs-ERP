/* The Sales Order and Delivery Order lists' exports — every document the list's
   CURRENT tab, search and filters match, across all pages (owner 2026-09-15).

   Two exports per list:
     · "Export lines" — one row per line. The server reads it
       (GET /mfg-sales-orders/export/lines, GET /delivery-orders-mfg/export/lines)
       through the list's own filter; this module sends the SAME parameters the
       list sends and writes the sheet.
     · the toolbar Export — one row per document, with the grid's visible
       columns. It reads the list endpoint itself, page after page, with the
       list's own parameters: the list's rows are assembled inside that handler
       (DO numbers, delivered progress, payment summary…), so asking it again is
       the only way the file's cells are the cells on screen.

   A read the server had to stop is REFUSED here, never written: a short file
   that looks complete is exactly the defect these exports replace. */

import { authedFetch } from './authed-fetch';
import { ExportTruncatedError } from './po-list-export';
import { appendSoListFilterParams } from './so-list-filter-state';
import type { SoListFilter } from '../../shared/so-list-filter-model';
import { applySoListMrpEnrichment, type EnrichableSoRow, type SoListMrpEnrichment } from '../../../lib/soListEnrichment';
import {
  SO_LINE_EXPORT_COLUMNS,
  SO_LINE_EXPORT_NUMBER_FORMATS,
  type SoLineExportCell,
} from './so-line-export-columns';
import {
  DO_LINE_EXPORT_COLUMNS,
  DO_LINE_EXPORT_NUMBER_FORMATS,
  type DoLineExportCell,
} from './do-line-export-columns';

export type SoListExportFilters = { status?: string; q?: string; sort?: string; filters: readonly SoListFilter[] };
export type DoListExportFilters = { status?: string; q?: string; sort?: string };

/** The SO list's filter as query parameters, exactly as useMfgSalesOrdersPaged
 *  builds them — tab upper-cased, the second-level rows as repeated `f` — no paging. */
export function soListParams(f: SoListExportFilters): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status && f.status !== 'all') usp.set('status', f.status.toUpperCase());
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  appendSoListFilterParams(usp, f.filters);
  return usp;
}

/** The DO list's filter as query parameters, exactly as useMfgDeliveryOrdersPaged builds them. */
export function doListParams(f: DoListExportFilters): URLSearchParams {
  const usp = new URLSearchParams();
  if (f.status) usp.set('status', f.status);
  if (f.q && f.q.trim()) usp.set('q', f.q.trim());
  if (f.sort) usp.set('sort', f.sort);
  return usp;
}

const withQuery = (path: string, usp: URLSearchParams) => (usp.toString() ? `${path}?${usp.toString()}` : path);

type Cell = SoLineExportCell | DoLineExportCell;
export type LineExportBody = { columns: string[]; rows: Cell[][]; lineCount: number; truncated: boolean };

async function fetchLineExport(path: string, usp: URLSearchParams, expected: readonly string[], what: string): Promise<LineExportBody> {
  const body = await authedFetch<LineExportBody>(withQuery(path, usp));
  if (body.truncated) throw new ExportTruncatedError(what);
  /* The header row IS the import contract. A server that answers with other
     columns (an older or newer deployment) must not produce a file an import
     would then misread. */
  if (body.columns.join('|') !== expected.join('|')) {
    throw new Error('The server sent a different set of export columns than this page expects. Reload the page and export again.');
  }
  return body;
}

export const fetchSoLineExport = (f: SoListExportFilters) =>
  fetchLineExport('/mfg-sales-orders/export/lines', soListParams(f), SO_LINE_EXPORT_COLUMNS, 'sales orders');

export const fetchDoLineExport = (f: DoListExportFilters) =>
  fetchLineExport('/delivery-orders-mfg/export/lines', doListParams(f), DO_LINE_EXPORT_COLUMNS, 'delivery orders');

async function writeSheet(
  columns: readonly string[],
  formats: Partial<Record<string, string>>,
  rows: Cell[][],
  sheetName: string,
  fileName: string,
): Promise<void> {
  const XLSX = await import('../../../lib/xlsx-runtime');
  const ws = XLSX.utils.aoa_to_sheet([[...columns], ...rows]) as Record<string, unknown>;
  columns.forEach((col, c) => {
    const fmt = formats[col];
    if (!fmt) return;
    for (let r = 1; r <= rows.length; r += 1) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as { t?: string; z?: string } | undefined;
      if (cell && cell.t === 'n') cell.z = fmt;
    }
  });
  ws['!cols'] = columns.map((col) => ({ wch: Math.min(42, Math.max(10, col.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFileXLSX(wb, fileName);
}

export const writeSoLineExportXlsx = (body: LineExportBody, fileName: string) =>
  writeSheet(SO_LINE_EXPORT_COLUMNS, SO_LINE_EXPORT_NUMBER_FORMATS, body.rows, 'SO Lines', fileName);

export const writeDoLineExportXlsx = (body: LineExportBody, fileName: string) =>
  writeSheet(DO_LINE_EXPORT_COLUMNS, DO_LINE_EXPORT_NUMBER_FORMATS, body.rows, 'DO Lines', fileName);

/* The list endpoints cap a page at 100 rows. Pages after the first go a few at
   a time: each one assembles its rows with several reads of its own. */
const LIST_PAGE = 100;
const LIST_CONCURRENCY = 3;

async function mapPool<T>(count: number, concurrency: number, work: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(count);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      out[i] = await work(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  return out;
}

/**
 * Every row of a paged list endpoint for the given filter, in the list's order.
 * A document that moves between pages while the pages are read (a new order
 * pushes the rest down) would be read twice or not at all, so the result is
 * checked against the total the first page reported and refused when it
 * disagrees — the person exports again, rather than sending a file one order
 * short.
 */
async function fetchAllListRows<T>(
  path: string,
  usp: URLSearchParams,
  key: (body: Record<string, unknown>) => T[] | undefined,
  idOf: (row: T) => string,
  what: string,
): Promise<T[]> {
  const pageUrl = (page: number) => {
    const p = new URLSearchParams(usp);
    p.set('page', String(page));
    p.set('pageSize', String(LIST_PAGE));
    return `${path}?${p.toString()}`;
  };
  const first = await authedFetch<Record<string, unknown> & { total?: number }>(pageUrl(0));
  const total = Number(first.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE));
  const rest = await mapPool(pages - 1, LIST_CONCURRENCY, (i) => authedFetch<Record<string, unknown>>(pageUrl(i + 1)));
  const rows = [first, ...rest].flatMap((b) => key(b) ?? []);
  const unique = new Set(rows.map(idOf));
  if (unique.size !== total || rows.length !== total) {
    throw new Error(`The ${what} changed while the export was being read (${unique.size} of ${total}), so no file was written. Export again.`);
  }
  return rows;
}

/* The SO list's own MRP enrichment chunk and pace (useSoListMrpEnrichmentMap):
   each request runs one company-wide MRP, so they go two at a time. */
const ENRICH_CHUNK = 100;
const ENRICH_CONCURRENCY = 2;

/**
 * Every Sales Order row the list's filters match, in the list's own row shape.
 * When `withMrpColumns` is set the MRP-derived fields (Stock Status, PO No.)
 * are healed exactly as the screen heals them (applySoListMrpEnrichment).
 */
export async function fetchAllSoListRows<T extends EnrichableSoRow & { doc_no: string }>(
  f: SoListExportFilters,
  withMrpColumns: boolean,
): Promise<T[]> {
  const rows = await fetchAllListRows<T>('/mfg-sales-orders', soListParams(f), (b) => b.salesOrders as T[] | undefined, (r) => r.doc_no, 'sales orders');
  if (!withMrpColumns || rows.length === 0) return rows;
  const docNos = [...new Set(rows.map((r) => r.doc_no))];
  const chunks: string[][] = [];
  for (let i = 0; i < docNos.length; i += ENRICH_CHUNK) chunks.push(docNos.slice(i, i + ENRICH_CHUNK));
  const byDoc = new Map<string, SoListMrpEnrichment>();
  await mapPool(chunks.length, ENRICH_CONCURRENCY, async (i) => {
    const res = await authedFetch<{ enrichment?: Record<string, SoListMrpEnrichment> }>(
      `/mfg-sales-orders/list-mrp-enrichment?docNos=${encodeURIComponent(chunks[i]!.join(','))}`,
    );
    for (const [k, v] of Object.entries(res.enrichment ?? {})) byDoc.set(k, v);
  });
  return rows.map((r) => applySoListMrpEnrichment(r, byDoc.get(r.doc_no)));
}

/** Every Delivery Order row the list's filters match, in the list's own row shape. */
export function fetchAllDoListRows<T extends { id: string }>(f: DoListExportFilters): Promise<T[]> {
  return fetchAllListRows<T>('/delivery-orders-mfg', doListParams(f), (b) => b.deliveryOrders as T[] | undefined, (r) => r.id, 'delivery orders');
}
