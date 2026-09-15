// ----------------------------------------------------------------------------
// so-list-lines — every line of a set of sales orders, as the SO list shows and
// exports them (owner 2026-09-15: the export follows the grid, one row per line,
// values as AutoCount holds them).
//
// ONE reader for both the screen and the file:
//   * GET /mfg-sales-orders?page=  attaches `lines` to the page it returns, so
//     the grid's line columns render;
//   * GET /mfg-sales-orders/export/rows attaches them to EVERY order the list's
//     filter matches (buildSoExportRows below), and the browser writes one row
//     per line with the grid's visible columns.
// Both go through attachSoLines, so a cell on screen and the same cell in the
// file cannot come from two different reads.
//
// A Sales Order has no header uuid: header and lines join on doc_no, and every
// read here carries the company predicate too (CLAUDE.md R105 b).
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { lookupByIds, type ExportWindow } from './document-line-export';
import { chunkIn } from './paginate-all';
import { pageWithTruncation } from './outstanding-po-lines';
import { fromSoList, orderSoList, type SoListRead } from './so-list-read';
import { buildSoListRows, type SoDeliverableMap, type SoListRow } from './so-list-rows';
import { warehouseLabel } from './warehouse-label';
import { bindingsFor } from './autocount-outbox';
import { doCountsAsDelivered } from '../shared/do-shipped-states';
import { buildVariantSummary } from '../shared/variant-summary';
import { bookSpellingOrOwn, resolveAcAgent, AC_DEBTOR_CODE } from '../../services/autocount-writeback';
import { LOCATION_MAP, VENUE_MAP, BRANDING_MAP } from '../../services/autocount-master-maps';
import { bookLineItem } from '../../services/autocount-book-item';
import { soDeliverableRemaining } from '../routes/delivery-orders-mfg';
import type { SoBookHeader, SoListLine } from './so-line-export-columns';

export const SO_LINE_READ_COLS =
  'id, doc_no, line_no, created_at, item_code, description, description2, variants, remark, item_group, uom, ' +
  'location, warehouse_id, qty, stock_status, unit_price_sen, discount_sen, total_sen, line_delivery_date';

type LineRow = {
  id: string;
  doc_no: string;
  line_no: number | null;
  created_at: string | null;
  item_code: string | null;
  description: string | null;
  description2: string | null;
  variants: unknown;
  remark: string | null;
  item_group: string | null;
  uom: string | null;
  location: string | null;
  warehouse_id: string | null;
  qty: number | string | null;
  stock_status: string | null;
  unit_price_sen: number | string | null;
  discount_sen: number | string | null;
  total_sen: number | string | null;
  line_delivery_date: string | null;
};

type Res<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
type Q = {
  select(cols: string): Q;
  order(col: string, opts: { ascending: boolean; nullsFirst?: boolean }): Q;
  in(col: string, vals: string[]): Q;
  eq(col: string, val: unknown): Q;
  not(col: string, op: string, val: unknown): Q;
  range(from: number, to: number): Res<unknown>;
};
type Sb = { from(table: string): Q };

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: string | null | undefined): string | null => String(v ?? '').trim() || null;
const ymd = (v: string | null | undefined): string | null => text(v)?.slice(0, 10) ?? null;

/* A line's printed position: line_no, then creation order, then id. */
const byLinePosition = (a: LineRow, b: LineRow): number => {
  const an = a.line_no ?? Infinity;
  const bn = b.line_no ?? Infinity;
  if (an !== bn) return an < bn ? -1 : 1;
  const ac = a.created_at ?? '';
  const bc = b.created_at ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/* "Detail Description 2" is the text composed from the line's variants (owner
   2026-09-15: 「description 2就是组成from variant的那个」), the stored text only
   where the variants compose nothing. */
function lineDescription2(itemGroup: string | null, variants: unknown, stored: string | null): string | null {
  const summary = variants && typeof variants === 'object' && !Array.isArray(variants)
    ? buildVariantSummary(itemGroup, variants as Record<string, unknown>).trim()
    : '';
  return summary || text(stored);
}

/* Rows that point at these SO lines by so_item_id. A small set asks by id in
   URL-sized batches; a large one reads the company's LINKED rows once and keeps
   the ones it needs — the same rows either way, in far fewer subrequests.
   Measured 2026-09-15 over the read-only shim on the full Houzs list (2,959
   orders, 15,618 lines): the by-id form cost 622 reads of delivery and purchase
   order lines; the company read costs one per 1,000 linked rows. */
const BY_ID_LIMIT = 1000;

async function readLinkedToLines<T extends { so_item_id: string | null }>(
  lineIds: string[],
  base: () => Q,
): Promise<{ data: T[]; error: string | null }> {
  if (lineIds.length <= BY_ID_LIMIT) {
    const r = await chunkIn<T>(lineIds, (batch, from, to) =>
      base().in('so_item_id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
    return { data: r.data, error: r.error ? r.error.message : null };
  }
  const wanted = new Set(lineIds);
  const r = await pageWithTruncation<T>((from, to) =>
    base().not('so_item_id', 'is', null).order('id', { ascending: true }).range(from, to));
  if (r.error) return { data: [], error: r.error.message };
  if (r.truncated) return { data: [], error: 'more linked lines than one export can read' };
  return { data: (r.data ?? []).filter((x) => !!x.so_item_id && wanted.has(x.so_item_id)), error: null };
}

type HeaderFields = SoListRow & {
  doc_no?: string;
  customer_delivery_date?: string | null;
  agent?: string | null;
  salesperson_id?: string | null;
  venue?: string | null;
  branding?: string | null;
  debtor_code?: string | null;
};

/**
 * Attach `lines` (SoListLine[], printed order) and the order's AutoCount header
 * spellings (SoBookHeader) to each row. `deliverable` is the delivered /
 * returned / remaining reading buildSoListRows already made for these orders;
 * pass null to read it here.
 */
export async function attachSoLines(
  sbIn: unknown,
  c: CompanyScopeCtx,
  rows: HeaderFields[],
  deliverable: SoDeliverableMap | null,
): Promise<{ error: string | null; lineCount: number }> {
  const sb = sbIn as Sb;
  const docNos = [...new Set(rows.map((r) => r.doc_no).filter((d): d is string => !!d))];
  if (docNos.length === 0) return { error: null, lineCount: 0 };

  const lineRead = await chunkIn<LineRow>(docNos, (batch, from, to) =>
    scopeToCompany(sb.from('mfg_sales_order_items').select(SO_LINE_READ_COLS), c)
      .in('doc_no', batch).order('doc_no', { ascending: true }).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (lineRead.error) return { error: `lines: ${lineRead.error.message}`, lineCount: 0 };
  const all = lineRead.data;
  const lineIds = all.map((l) => l.id);

  /* AutoCount's number — a base-table column the list's view does not carry. */
  const base = await chunkIn<{ doc_no: string; linked_ac_docno: string | null }>(docNos, (batch, from, to) =>
    scopeToCompany(sb.from('mfg_sales_orders').select('doc_no, linked_ac_docno'), c)
      .in('doc_no', batch).order('doc_no', { ascending: true }).range(from, to) as Res<never>);
  if (base.error) return { error: `sales order headers: ${base.error.message}`, lineCount: 0 };
  const acDocNo = new Map(base.data.map((b) => [b.doc_no, text(b.linked_ac_docno)]));

  let reading = deliverable;
  if (!reading) {
    try {
      reading = await soDeliverableRemaining(sb, docNos);
    } catch (e) {
      return { error: `delivered quantities: ${(e as Error).message}`, lineCount: 0 };
    }
  }

  /* Delivery order lines: DO numbers (not cancelled) and qty on a DO that has
     not shipped by the app's rule (doCountsAsDelivered). */
  type DoLine = { id: string; so_item_id: string | null; qty: number | null; delivery_order_id: string | null };
  const doLines = await readLinkedToLines<DoLine>(lineIds, () =>
    scopeToCompany(sb.from('delivery_order_items').select('id, so_item_id, qty, delivery_order_id'), c));
  if (doLines.error) return { error: `delivery order lines: ${doLines.error}`, lineCount: 0 };
  const dos = await lookupByIds<{ id: string; do_number: string | null; status: string | null }>(
    doLines.data.map((l) => l.delivery_order_id),
    (batch, from, to) => scopeToCompany(sb.from('delivery_orders').select('id, do_number, status'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (dos.error) return { error: `delivery orders: ${dos.error}`, lineCount: 0 };
  const doNos = new Map<string, Set<string>>();
  const onDo = new Map<string, number>();
  for (const l of doLines.data) {
    const d = l.delivery_order_id ? dos.byId.get(l.delivery_order_id) : undefined;
    if (!l.so_item_id || !d || String(d.status ?? '').toUpperCase() === 'CANCELLED') continue;
    if (d.do_number) doNos.set(l.so_item_id, (doNos.get(l.so_item_id) ?? new Set()).add(d.do_number));
    if (!doCountsAsDelivered(d.status)) onDo.set(l.so_item_id, (onDo.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
  }

  /* Purchase order lines raised for these lines (PO not cancelled). */
  type PoLine = { id: string; so_item_id: string | null; purchase_order_id: string | null; delivery_date: string | null };
  const poLines = await readLinkedToLines<PoLine>(lineIds, () =>
    scopeToCompany(sb.from('purchase_order_items').select('id, so_item_id, purchase_order_id, delivery_date'), c));
  if (poLines.error) return { error: `purchase order lines: ${poLines.error}`, lineCount: 0 };
  const pos = await lookupByIds<{ id: string; po_number: string | null; status: string | null }>(
    poLines.data.map((l) => l.purchase_order_id),
    (batch, from, to) => scopeToCompany(sb.from('purchase_orders').select('id, po_number, status'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (pos.error) return { error: `purchase orders: ${pos.error}`, lineCount: 0 };
  const poNos = new Map<string, Set<string>>();
  const poDate = new Map<string, string>();
  for (const l of poLines.data) {
    const p = l.purchase_order_id ? pos.byId.get(l.purchase_order_id) : undefined;
    if (!l.so_item_id || !p || String(p.status ?? '').toUpperCase() === 'CANCELLED') continue;
    if (p.po_number) poNos.set(l.so_item_id, (poNos.get(l.so_item_id) ?? new Set()).add(p.po_number));
    const dd = ymd(l.delivery_date);
    const cur = poDate.get(l.so_item_id);
    if (dd && (!cur || dd < cur)) poDate.set(l.so_item_id, dd);
  }

  /* Warehouses and staff by the ids of rows already read under the company scope. */
  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(
    all.map((l) => l.warehouse_id),
    (batch, from, to) => sb.from('warehouses').select('id, code, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (wh.error) return { error: `warehouses: ${wh.error}`, lineCount: 0 };
  const staff = await lookupByIds<{ id: string; name: string | null }>(
    rows.map((r) => r.salesperson_id ?? null),
    (batch, from, to) => sb.from('staff').select('id, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (staff.error) return { error: `staff: ${staff.error}`, lineCount: 0 };

  /* The write-back's own binding map, so an item resolves as the book was sent it. */
  let bindings: Map<string, string>;
  try {
    bindings = await bindingsFor(sb as never, (c.get('companyId') as number | undefined) ?? null, all.map((l) => l.item_code ?? ''));
  } catch (e) {
    return { error: `item bindings: ${(e as Error).message}`, lineCount: 0 };
  }

  const byDoc = new Map<string, LineRow[]>();
  for (const l of all) byDoc.set(l.doc_no, [...(byDoc.get(l.doc_no) ?? []), l]);

  for (const r of rows) {
    const docNo = r.doc_no ?? '';
    const inBook = acDocNo.get(docNo) != null;
    const staffName = r.salesperson_id ? text(staff.byId.get(r.salesperson_id)?.name) : null;
    const book: SoBookHeader = {
      ac_doc_no: acDocNo.get(docNo) ?? (docNo || null),
      ac_debtor_code: inBook ? (text(r.debtor_code) ?? AC_DEBTOR_CODE) : text(r.debtor_code),
      ac_agent: inBook ? resolveAcAgent(r.agent, staffName) : (text(r.agent) ?? staffName),
      ac_venue: inBook ? bookSpellingOrOwn(r.venue, VENUE_MAP) : text(r.venue),
      ac_branding: inBook ? bookSpellingOrOwn(r.branding, BRANDING_MAP) : text(r.branding),
    };
    const lines: SoListLine[] = [...(byDoc.get(docNo) ?? [])].sort(byLinePosition).map((l) => {
      const item = inBook
        ? bookLineItem({ itemCode: l.item_code, description: l.description, category: l.item_group, uom: l.uom }, null, { bindings })
        : null;
      const d = reading.get(l.id);
      const w = l.warehouse_id ? wh.byId.get(l.warehouse_id) : null;
      return {
        id: l.id,
        line_no: l.line_no,
        item_code: item ? item.itemCode : text(l.item_code),
        erp_item_code: text(l.item_code),
        description: item ? item.description : text(l.description),
        description2: lineDescription2(l.item_group, l.variants, l.description2),
        item_group: item ? item.itemGroup : text(l.item_group),
        uom: item ? item.uom : text(l.uom),
        location: bookSpellingOrOwn(warehouseLabel(w) ?? l.location, LOCATION_MAP),
        qty: num(l.qty) ?? 0,
        unit_price_sen: num(l.unit_price_sen),
        discount_sen: num(l.discount_sen),
        total_sen: num(l.total_sen),
        delivery_date: ymd(l.line_delivery_date) ?? ymd(r.customer_delivery_date),
        remark: text(l.remark),
        stock_status: text(l.stock_status),
        delivered_qty: d ? d.delivered : null,
        returned_qty: d ? d.returned : null,
        remaining_qty: d ? d.remaining : null,
        on_delivery_order_qty: onDo.get(l.id) ?? 0,
        do_nos: [...(doNos.get(l.id) ?? [])].sort(),
        po_nos: [...(poNos.get(l.id) ?? [])].sort(),
        po_delivery_date: poDate.get(l.id) ?? null,
      };
    });
    Object.assign(r, book, { lines });
  }
  return { error: null, lineCount: all.length };
}

/* buildSoListRows sizes its per-doc reads for one list page (≤ 100 orders); the
   export hands it the matched orders in pages of that size. */
const ROW_PAGE = 100;

export type SoExportRows =
  | { error: string }
  | { error: null; salesOrders: SoListRow[]; total: number; lineCount: number; next: number | null };

/**
 * One WINDOW of the sales orders the list's filter matches, in the list's own
 * row shape — buildSoListRows, the list handler's builder — each carrying
 * `lines`. `next` is the offset of the following window, null after the last.
 */
export async function buildSoExportRows(
  sb: Variables['supabase'],
  c: Context<{ Bindings: Env; Variables: Variables }>,
  read: Extract<SoListRead, { ok: true }>,
  sort: string | null,
  listCols: string,
  window: ExportWindow,
): Promise<SoExportRows> {
  const head = await orderSoList(read.header(fromSoList(sb, listCols)), sort)
    .range(window.offset, window.offset + window.limit - 1);
  if (head.error) return { error: `sales orders: ${head.error.message}` };
  const rows = (head.data ?? []) as unknown as SoListRow[];
  let lineCount = 0;
  for (let i = 0; i < rows.length; i += ROW_PAGE) {
    const page = rows.slice(i, i + ROW_PAGE);
    const deliverable = await buildSoListRows(sb, c, page);
    const attached = await attachSoLines(sb, c, page, deliverable);
    if (attached.error) return { error: attached.error };
    lineCount += attached.lineCount;
  }
  return { error: null, salesOrders: rows, total: rows.length, lineCount, next: rows.length === window.limit ? window.offset + window.limit : null };
}
