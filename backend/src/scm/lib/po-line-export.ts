// ----------------------------------------------------------------------------
// po-line-export — the Purchase Order plug-in for document-line-export.
//
// Every line of every purchase order the PO list's CURRENT tab, search and sort
// match, across all pages, shaped as the columns in po-line-export-columns.ts.
// Read by GET /mfg-purchase-orders/export/lines (routes/purchase-order-exports.ts).
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { readDocumentsWithLines, lookupByIds } from './document-line-export';
import { filterPoList, orderPoList, type PoListFilters } from './po-list-read';
import { warehouseLabel } from './warehouse-label';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import {
  PO_ESTIMATE_DELIVERY_DATE_FIELDS,
  PO_LINE_EXPORT_COLUMNS,
  poEstimateDeliveryDates,
  poLineExportCells,
  type PoEstimateDates,
  type PoExportHeader,
  type PoExportLine,
  type PoLineExportCell,
} from './po-line-export-columns';

const ESTIMATE_COLS = PO_ESTIMATE_DELIVERY_DATE_FIELDS.join(', ');

export const PO_EXPORT_HEADER_COLS =
  `id, po_number, linked_ac_docno, po_date, status, on_hold, purchase_location_id, ${ESTIMATE_COLS}, supplier:suppliers(code, name)`;

export const PO_EXPORT_LINE_COLS =
  'id, purchase_order_id, line_no, created_at, item_code, supplier_sku, material_name, description2, notes, ' +
  `item_group, warehouse_id, qty, received_qty, unit_price_sen, line_total_sen, delivery_date, ${ESTIMATE_COLS}, so_item_id`;

type HeaderRow = PoExportHeader & { id: string; purchase_location_id: string | null };
type LineRow = PoExportLine & {
  purchase_order_id: string;
  line_no: number | null;
  created_at: string | null;
  warehouse_id: string | null;
  so_item_id: string | null;
};

/* The builder surface the reads below use — structural, so the test fake and
   supabase-js both satisfy it without an `any`. */
type Q = {
  select(cols: string): Q;
  order(col: string, opts: { ascending: boolean; nullsFirst?: boolean }): Q;
  in(col: string, vals: string[]): Q;
  eq(col: string, val: unknown): Q;
  or(filters: string): Q;
  gte(col: string, val: unknown): Q;
  lte(col: string, val: unknown): Q;
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
};
type Sb = { from(table: string): Q };

/* A PO line's printed position: line_no, then creation order, then id (the
   same order lib/po-line-order.ts `inPoLineOrder` asks the database for). */
const byLinePosition = (a: LineRow, b: LineRow): number => {
  const an = a.line_no ?? -Infinity;
  const bn = b.line_no ?? -Infinity;
  if (an !== bn) return an < bn ? -1 : 1;
  const ac = a.created_at ?? '';
  const bc = b.created_at ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Estimate Delivery Date 1/2/3 for rows that name a PO line and its PO — the
 * Outstanding "PO Chasing" tab's rows (scm.v_po_outstanding_lines). Reads the
 * three dates from the line and its header and resolves them through the SAME
 * rule the export uses, so the two screens cannot disagree on a date.
 *
 * `scope` is the caller's company predicate: that tab is cross-company
 * (scopeToAllowedCompanies), the export is not.
 */
export async function resolvePoEstimateDates(
  sbIn: unknown,
  scope: <T>(q: T) => T,
  rows: Array<{ po_id?: unknown; po_item_id?: unknown }>,
): Promise<{ error: string | null; byLineId: Map<string, [string | null, string | null, string | null]> }> {
  const sb = sbIn as Sb;
  const poIds = rows.map((r) => (typeof r.po_id === 'string' ? r.po_id : null));
  type DateRow = PoEstimateDates & { id: string; purchase_order_id?: string };
  const cast = (q: PromiseLike<unknown>) => q as PromiseLike<{ data: DateRow[] | null; error: { message: string } | null }>;
  const headers = await lookupByIds<DateRow>(poIds, (batch, from, to) =>
    cast(scope(sb.from('purchase_orders').select(`id, ${ESTIMATE_COLS}`)).in('id', batch).order('id', { ascending: true }).range(from, to)));
  if (headers.error) return { error: `purchase orders: ${headers.error}`, byLineId: new Map() };
  const lines = await lookupByIds<DateRow>(poIds, (batch, from, to) =>
    cast(scope(sb.from('purchase_order_items').select(`id, purchase_order_id, ${ESTIMATE_COLS}`))
      .in('purchase_order_id', batch).order('id', { ascending: true }).range(from, to)));
  if (lines.error) return { error: `purchase order lines: ${lines.error}`, byLineId: new Map() };
  const byLineId = new Map<string, [string | null, string | null, string | null]>();
  for (const line of lines.byId.values()) {
    byLineId.set(line.id, poEstimateDeliveryDates(line, headers.byId.get(line.purchase_order_id ?? '')));
  }
  return { error: null, byLineId };
}

export type PoLineExport =
  | { error: string }
  | {
      error: null;
      columns: readonly string[];
      rows: PoLineExportCell[][];
      poCount: number;
      lineCount: number;
      truncated: boolean;
    };

export async function buildPoLineExport(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: PoListFilters,
  validStatuses: ReadonlySet<string>,
): Promise<PoLineExport> {
  const sb = sbIn as Sb;
  const read = await readDocumentsWithLines<HeaderRow, LineRow>({
    headers: (from, to) =>
      orderPoList(filterPoList(sb.from('purchase_orders').select(PO_EXPORT_HEADER_COLS), filters, c, validStatuses), filters.sort)
        .range(from, to),
    /* The company predicate on the LINE read too: a parent id is not company
       scope (CLAUDE.md R105 b). */
    lines: (batch, from, to) =>
      scopeToCompany(sb.from('purchase_order_items').select(PO_EXPORT_LINE_COLS), c)
        .in('purchase_order_id', batch)
        .order('purchase_order_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as PromiseLike<{ data: LineRow[] | null; error: { message: string } | null }>,
    parentOf: (l) => l.purchase_order_id,
  });
  if (read.error !== null) return { error: read.error };

  const allLines = [...read.linesByHeader.values()].flat();

  /* The SO number a line was raised for. Company-scoped: a line pointing at
     another company's sales order must not print that company's number. */
  const so = await lookupByIds<{ id: string; doc_no: string | null }>(
    allLines.map((l) => l.so_item_id),
    (batch, from, to) =>
      scopeToCompany(sb.from('mfg_sales_order_items').select('id, doc_no'), c)
        .in('id', batch)
        .order('id', { ascending: true })
        .range(from, to) as PromiseLike<{ data: Array<{ id: string; doc_no: string | null }> | null; error: { message: string } | null }>,
  );
  if (so.error) return { error: `sales order numbers: ${so.error}` };

  /* The line's warehouse, else the PO header's — the line OVERRIDES the header
     (lib/outstanding-po-lines.ts toOutstandingPoItems) — printed as AutoCount's
     SHORT code (`KL`, not `KL WAREHOUSE`; owner 2026-09-15). The short code
     is the write-back's own rule, code-or-name through LOCATION_MAP
     (lib/autocount-convert-lines.ts readConvertHeaderFacts), so the file names a
     warehouse exactly as the account book does. Warehouses are read by the ids
     of rows already read under the company scope. */
  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(
    [...allLines.map((l) => l.warehouse_id), ...read.headers.map((h) => h.purchase_location_id)],
    (batch, from, to) =>
      sb.from('warehouses').select('id, code, name')
        .in('id', batch)
        .order('id', { ascending: true })
        .range(from, to) as PromiseLike<{ data: Array<{ id: string; code: string | null; name: string | null }> | null; error: { message: string } | null }>,
  );
  if (wh.error) return { error: `warehouses: ${wh.error}` };

  const rows: PoLineExportCell[][] = [];
  for (const header of read.headers) {
    const lines = [...(read.linesByHeader.get(header.id) ?? [])].sort(byLinePosition);
    const headerWarehouse = header.purchase_location_id ? wh.byId.get(header.purchase_location_id) : null;
    for (const line of lines) {
      const lineWarehouse = line.warehouse_id ? wh.byId.get(line.warehouse_id) : null;
      rows.push(poLineExportCells(header, line, {
        soDocNo: line.so_item_id ? so.byId.get(line.so_item_id)?.doc_no ?? null : null,
        location: bookSpellingOrOwn(warehouseLabel(lineWarehouse) ?? warehouseLabel(headerWarehouse), LOCATION_MAP),
      }));
    }
  }

  return {
    error: null,
    columns: PO_LINE_EXPORT_COLUMNS,
    rows,
    poCount: read.headers.length,
    lineCount: rows.length,
    truncated: read.truncated,
  };
}
