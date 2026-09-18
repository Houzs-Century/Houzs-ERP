// ----------------------------------------------------------------------------
// po-line-export — every line of a set of purchase orders, as the PO list shows
// and exports them (owner 2026-09-15: the export follows the grid, one row per
// line).
//
// ONE reader for both the screen and the file:
//   * GET /mfg-purchase-orders?page=  attaches `lines` to the page it returns,
//     so the grid's line columns (Item Code, Qty, Delivery Date, ...) render;
//   * GET /mfg-purchase-orders/export/rows attaches them to EVERY purchase order
//     the list's tab, search and sort match (routes/purchase-order-exports.ts),
//     and the browser writes one row per line with the grid's visible columns.
// Both go through attachPoLines, so a cell on screen and the same cell in the
// file cannot come from two different reads.
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { lookupByIds } from './document-line-export';
import { chunkIn } from './paginate-all';
import { pageWithTruncation } from './outstanding-po-lines';
import { poListSelect, filterPoList, orderPoList, stampPoListGrns, type PoListFilters } from './po-list-read';
import { warehouseLabel } from './warehouse-label';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { poLineDescription2 } from './po-line-description2';
import { acBookItemIndex } from '../../services/autocount-book-item';
import {
  PO_ESTIMATE_DELIVERY_DATE_FIELDS,
  poEstimateDeliveryDates,
  toPoListLine,
  type PoEstimateDates,
  type PoLineSource,
  type PoListLine,
} from './po-line-export-columns';

const ESTIMATE_COLS = PO_ESTIMATE_DELIVERY_DATE_FIELDS.join(', ');

export const PO_LINE_READ_COLS =
  'id, purchase_order_id, line_no, created_at, item_code, supplier_sku, material_name, description2, notes, ' +
  `item_group, variants, warehouse_id, qty, received_qty, unit_price_sen, line_total_sen, delivery_date, ${ESTIMATE_COLS}, so_item_id`;

type LineRow = PoLineSource & {
  purchase_order_id: string;
  created_at: string | null;
  warehouse_id: string | null;
  so_item_id: string | null;
  variants: unknown;
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
type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

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

export type PoLineHeader = PoEstimateDates & { id: string; purchase_location_id?: string | null };

/**
 * Attach `lines` (PoListLine[], in printed order) to each purchase order. The
 * headers must already have been read under the company scope; the line read
 * and the sales-order lookup carry the company predicate themselves (a parent
 * id is not company scope, CLAUDE.md R105 b).
 */
export async function attachPoLines<H extends PoLineHeader>(
  sbIn: unknown,
  c: CompanyScopeCtx,
  headers: H[],
): Promise<{ error: string | null; rows: Array<H & { lines: PoListLine[] }>; lineCount: number }> {
  const sb = sbIn as Sb;
  const ids = [...new Set(headers.map((h) => h.id))];
  const lineRead = await chunkIn<LineRow>(ids, (batch, from, to) =>
    scopeToCompany(sb.from('purchase_order_items').select(PO_LINE_READ_COLS), c)
      .in('purchase_order_id', batch)
      .order('purchase_order_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to) as Page<LineRow>);
  if (lineRead.error) return { error: `lines: ${lineRead.error.message}`, rows: [], lineCount: 0 };
  const all = lineRead.data;

  /* The SO number a line was raised for. Company-scoped: a line pointing at
     another company's sales order must not print that company's number. */
  const so = await lookupByIds<{ id: string; doc_no: string | null }>(
    all.map((l) => l.so_item_id),
    (batch, from, to) =>
      scopeToCompany(sb.from('mfg_sales_order_items').select('id, doc_no'), c)
        .in('id', batch)
        .order('id', { ascending: true })
        .range(from, to) as Page<{ id: string; doc_no: string | null }>,
  );
  if (so.error) return { error: `sales order numbers: ${so.error}`, rows: [], lineCount: 0 };

  /* The line's warehouse, else the PO header's — the line OVERRIDES the header
     (lib/outstanding-po-lines.ts toOutstandingPoItems) — as AutoCount's SHORT
     code (`KL`, not `KL WAREHOUSE`; owner 2026-09-15), through the write-back's
     own code-or-name + LOCATION_MAP rule (lib/autocount-convert-lines.ts
     readConvertHeaderFacts). Read by the ids of rows already company-scoped. */
  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(
    [...all.map((l) => l.warehouse_id), ...headers.map((h) => h.purchase_location_id ?? null)],
    (batch, from, to) =>
      sb.from('warehouses').select('id, code, name')
        .in('id', batch)
        .order('id', { ascending: true })
        .range(from, to) as Page<{ id: string; code: string | null; name: string | null }>,
  );
  if (wh.error) return { error: `warehouses: ${wh.error}`, rows: [], lineCount: 0 };

  const master = acBookItemIndex();
  const bookOf = (sku: string | null | undefined) => {
    const hit = master.get(String(sku ?? '').trim().toUpperCase());
    return hit ? { description: hit.description, itemGroup: hit.itemGroup } : null;
  };

  const byPo = new Map<string, LineRow[]>();
  for (const l of all) {
    const arr = byPo.get(l.purchase_order_id) ?? [];
    arr.push(l);
    byPo.set(l.purchase_order_id, arr);
  }
  const rows = headers.map((h) => {
    const headerWarehouse = h.purchase_location_id ? wh.byId.get(h.purchase_location_id) : null;
    const lines = [...(byPo.get(h.id) ?? [])].sort(byLinePosition).map((l) => toPoListLine(h, { ...l, description2: poLineDescription2(l.item_group, l.variants, l.description2) }, {
      soDocNo: l.so_item_id ? so.byId.get(l.so_item_id)?.doc_no ?? null : null,
      /* AutoCount lists a purchase line under the SUPPLIER's item code, and its
         Item Description / Item Group are that item's (the book's item master,
         services/autocount-book-item.ts). Measured 2026-09-15 against the owner's
         AutoCount PO chasing list: 240 / 240 matched lines agree on both. */
      book: bookOf(l.supplier_sku),
      location: bookSpellingOrOwn(
        warehouseLabel(l.warehouse_id ? wh.byId.get(l.warehouse_id) : null) ?? warehouseLabel(headerWarehouse),
        LOCATION_MAP,
      ),
    }));
    return { ...h, lines };
  });
  return { error: null, rows, lineCount: all.length };
}

export type PoExportRows =
  | { error: string }
  | {
      error: null;
      purchaseOrders: Array<{ id: string } & Record<string, unknown> & { lines: PoListLine[] }>;
      total: number;
      lineCount: number;
      truncated: boolean;
    };

/**
 * EVERY purchase order the list's filter matches (all pages), in the list's own
 * row shape (GRN stamp included), each carrying its lines.
 */
export async function buildPoExportRows(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: PoListFilters,
  validStatuses: ReadonlySet<string>,
): Promise<PoExportRows> {
  const sb = sbIn as Sb;
  const read = await pageWithTruncation<{ id: string; purchase_location_id?: string | null } & Record<string, unknown>>((from, to) =>
    orderPoList(filterPoList(sb.from('purchase_orders').select(poListSelect(filters)), filters, c, validStatuses), filters.sort)
      .range(from, to));
  if (read.error) return { error: `purchase orders: ${read.error.message}` };
  const stamped = await stampPoListGrns(sb, read.data ?? []);
  if (stamped.error) return { error: `GRNs: ${stamped.error}` };
  const withLines = await attachPoLines(sb, c, stamped.rows);
  if (withLines.error) return { error: withLines.error };
  return {
    error: null,
    purchaseOrders: withLines.rows,
    total: withLines.rows.length,
    lineCount: withLines.lineCount,
    truncated: read.truncated,
  };
}

/**
 * Estimate Delivery Date 1/2/3 for rows that name a PO line and its PO — the
 * Outstanding "PO Chasing" tab's rows (scm.v_po_outstanding_lines). Reads the
 * three dates from the line and its header and resolves them through the SAME
 * rule the grid uses, so the two screens cannot disagree on a date.
 *
 * `scope` is the caller's company predicate: that tab is cross-company
 * (scopeToAllowedCompanies), the list is not.
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
