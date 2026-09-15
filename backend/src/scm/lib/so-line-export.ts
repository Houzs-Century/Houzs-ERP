// ----------------------------------------------------------------------------
// so-line-export — the Sales Order plug-in for document-line-export.
//
// Every line of every sales order the SO list's CURRENT tab, search, date window
// and second-level filter rows match, across all pages, shaped as the columns in
// so-line-export-columns.ts. Read by GET /mfg-sales-orders/export/lines
// (routes/sales-order-exports.ts).
//
// A Sales Order has no header uuid: header and lines join on doc_no, and every
// read here carries the company predicate too, because a doc number is not
// company scope (CLAUDE.md R105 b).
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { readDocumentsWithLines, lookupByIds } from './document-line-export';
import { fromSoList, orderSoList, type SoListRead } from './so-list-read';
import { warehouseLabel } from './warehouse-label';
import { chunkIn } from './paginate-all';
import { pageWithTruncation } from './outstanding-po-lines';
import { doCountsAsDelivered } from '../shared/do-shipped-states';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { computeSoLifecycle, soDeliverableRemaining, type SoLifecycle } from '../routes/delivery-orders-mfg';
import {
  SO_LINE_EXPORT_COLUMNS,
  soLineExportCells,
  soListStatusWord,
  soSalespersonName,
  type SoDeliveryState,
  type SoExportHeader,
  type SoExportLine,
  type SoLineExportCell,
} from './so-line-export-columns';


/* The list reads the payment-totals VIEW (its filters compare view-computed
   columns), so every column here must exist on the view — see the VIEW-TRAP
   note in routes/mfg-sales-orders.ts. linked_ac_docno and delivery_address1..4
   are NOT on it and are read from the base table below. */
export const SO_EXPORT_HEADER_COLS =
  'doc_no, so_date, status, on_hold, debtor_code, debtor_name, ref, customer_so_no, branding, venue, ' +
  'sales_location, phone, address1, address2, address3, address4, customer_state, customer_delivery_date, ' +
  'processing_date, salesperson_id, agent, balance_sen, balance_sen_live';

export const SO_EXPORT_LINE_COLS =
  'id, doc_no, line_no, created_at, item_code, description, description2, remark, item_group, uom, ' +
  'location, warehouse_id, qty, stock_status, unit_price_sen, discount_sen, total_sen, line_delivery_date';

type HeaderRow = SoExportHeader & { id: string; salesperson_id: string | null; agent: string | null };
type LineRow = SoExportLine & {
  doc_no: string;
  line_no: number | null;
  created_at: string | null;
  location: string | null;
  warehouse_id: string | null;
};

type Res<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
/* The builder surface the reads below use — structural, so the test fake, the
   read-only shim and supabase-js all satisfy it without an `any`. */
type Q = {
  select(cols: string): Q;
  order(col: string, opts: { ascending: boolean; nullsFirst?: boolean }): Q;
  in(col: string, vals: string[]): Q;
  eq(col: string, val: unknown): Q;
  not(col: string, op: string, val: unknown): Q;
  range(from: number, to: number): Res<unknown>;
};
type Sb = { from(table: string): Q };

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

/* The list's per-order status inputs are computed for at most one page of
   orders at a time (pageSize ≤ 100); computeSoLifecycle reads by an unchunked
   doc-number list, so it is asked the same size of question here. */
const LIFECYCLE_BATCH = 100;

/* Rows that point at these SO lines by so_item_id. A small export asks by id in
   URL-sized batches; a large one reads the company's LINKED rows once and keeps
   the ones it needs — the same rows either way, in far fewer subrequests (a
   Worker caps subrequests per request). Measured 2026-09-15 over the read-only
   shim on the full Houzs list (2,959 orders, 15,618 lines): the by-id form cost
   622 reads of delivery and purchase order lines; the company read costs one
   per 1,000 linked rows. */
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

export type SoLineExport =
  | { error: string }
  | {
      error: null;
      columns: readonly string[];
      rows: SoLineExportCell[][];
      soCount: number;
      lineCount: number;
      truncated: boolean;
    };

export async function buildSoLineExport(
  sbIn: unknown,
  c: CompanyScopeCtx,
  read: Extract<SoListRead, { ok: true }>,
  sort: string | null,
): Promise<SoLineExport> {
  const sb = sbIn as Sb;
  const docs = await readDocumentsWithLines<HeaderRow, LineRow>({
    headers: (from, to) =>
      (orderSoList(read.header(fromSoList(sb, SO_EXPORT_HEADER_COLS)), sort).range(from, to) as Res<SoExportHeader>)
        .then((r) => ({ data: r.data ? r.data.map((h) => ({ ...h, id: h.doc_no })) : null, error: r.error })),
    lines: (batch, from, to) =>
      scopeToCompany(sb.from('mfg_sales_order_items').select(SO_EXPORT_LINE_COLS), c)
        .in('doc_no', batch)
        .order('doc_no', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as Res<LineRow>,
    parentOf: (l) => l.doc_no,
  });
  if (docs.error !== null) return { error: docs.error };

  const docNos = docs.headers.map((h) => h.doc_no);
  const allLines = [...docs.linesByHeader.values()].flat();
  const lineIds = allLines.map((l) => l.id);

  /* The two header facts the view does not carry. */
  const base = await chunkIn<{ doc_no: string; linked_ac_docno: string | null; delivery_address1: string | null; delivery_address2: string | null; delivery_address3: string | null; delivery_address4: string | null }>(
    docNos,
    (batch, from, to) => scopeToCompany(sb.from('mfg_sales_orders')
      .select('doc_no, linked_ac_docno, delivery_address1, delivery_address2, delivery_address3, delivery_address4'), c)
      .in('doc_no', batch).order('doc_no', { ascending: true }).range(from, to) as Res<never>,
  );
  if (base.error) return { error: `sales order headers: ${base.error.message}` };
  const baseByDoc = new Map(base.data.map((b) => [b.doc_no, b]));

  /* Delivered / Returned / Remaining — the app's own reading, the one the SO
     list's Delivered column, the SO→DO picker and MRP use. It reads its own
     lines by doc number (non-cancelled lines only). */
  let deliverable: Awaited<ReturnType<typeof soDeliverableRemaining>>;
  try {
    deliverable = await soDeliverableRemaining(sb, docNos);
  } catch (e) {
    return { error: `delivered quantities: ${(e as Error).message}` };
  }

  /* The list's status pill inputs, per order, exactly as GET /mfg-sales-orders
     derives them: delivery_state from the same deliverable sums, and the
     latest-event lifecycle. */
  const deliveredByDoc = new Map<string, number>();
  const remainingByDoc = new Map<string, number>();
  for (const l of deliverable.values()) {
    deliveredByDoc.set(l.docNo, (deliveredByDoc.get(l.docNo) ?? 0) + l.delivered);
    remainingByDoc.set(l.docNo, (remainingByDoc.get(l.docNo) ?? 0) + l.remaining);
  }
  const lifecycle = new Map<string, SoLifecycle>();
  for (let i = 0; i < docNos.length; i += LIFECYCLE_BATCH) {
    for (const [k, v] of await computeSoLifecycle(sb, docNos.slice(i, i + LIFECYCLE_BATCH))) lifecycle.set(k, v);
  }

  /* Delivery order lines linked to these lines: the DO numbers (not cancelled)
     and the quantity still on a delivery order that has not shipped. */
  type DoLine = { id: string; so_item_id: string | null; qty: number | null; delivery_order_id: string | null };
  const doLines = await readLinkedToLines<DoLine>(lineIds, () =>
    scopeToCompany(sb.from('delivery_order_items').select('id, so_item_id, qty, delivery_order_id'), c));
  if (doLines.error) return { error: `delivery order lines: ${doLines.error}` };
  const dos = await lookupByIds<{ id: string; do_number: string | null; status: string | null }>(
    doLines.data.map((l) => l.delivery_order_id),
    (batch, from, to) => scopeToCompany(sb.from('delivery_orders').select('id, do_number, status'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>,
  );
  if (dos.error) return { error: `delivery orders: ${dos.error}` };
  const doNosByLine = new Map<string, Set<string>>();
  const onDoByLine = new Map<string, number>();
  for (const l of doLines.data) {
    const d = l.delivery_order_id ? dos.byId.get(l.delivery_order_id) : undefined;
    if (!l.so_item_id || !d || String(d.status ?? '').toUpperCase() === 'CANCELLED') continue;
    if (d.do_number) doNosByLine.set(l.so_item_id, (doNosByLine.get(l.so_item_id) ?? new Set()).add(d.do_number));
    if (!doCountsAsDelivered(d.status)) onDoByLine.set(l.so_item_id, (onDoByLine.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
  }

  /* Purchase order lines raised for these lines (not cancelled): the PO
     numbers and the earliest PO delivery date. */
  type PoLine = { id: string; so_item_id: string | null; purchase_order_id: string | null; delivery_date: string | null };
  const poLines = await readLinkedToLines<PoLine>(lineIds, () =>
    scopeToCompany(sb.from('purchase_order_items').select('id, so_item_id, purchase_order_id, delivery_date'), c));
  if (poLines.error) return { error: `purchase order lines: ${poLines.error}` };
  const pos = await lookupByIds<{ id: string; po_number: string | null; status: string | null }>(
    poLines.data.map((l) => l.purchase_order_id),
    (batch, from, to) => scopeToCompany(sb.from('purchase_orders').select('id, po_number, status'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>,
  );
  if (pos.error) return { error: `purchase orders: ${pos.error}` };
  const poNosByLine = new Map<string, Set<string>>();
  const poDateByLine = new Map<string, string>();
  for (const l of poLines.data) {
    const p = l.purchase_order_id ? pos.byId.get(l.purchase_order_id) : undefined;
    if (!l.so_item_id || !p || String(p.status ?? '').toUpperCase() === 'CANCELLED') continue;
    if (p.po_number) poNosByLine.set(l.so_item_id, (poNosByLine.get(l.so_item_id) ?? new Set()).add(p.po_number));
    const dd = (l.delivery_date ?? '').slice(0, 10);
    const cur = poDateByLine.get(l.so_item_id);
    if (dd && (!cur || dd < cur)) poDateByLine.set(l.so_item_id, dd);
  }

  /* Warehouses and staff are read by the ids of rows already read under the
     company scope. */
  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(
    allLines.map((l) => l.warehouse_id),
    (batch, from, to) => sb.from('warehouses').select('id, code, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>,
  );
  if (wh.error) return { error: `warehouses: ${wh.error}` };
  const staff = await lookupByIds<{ id: string; name: string | null; staff_code: string | null }>(
    /* the salesperson id, and an agent text that holds a uuid (soSalespersonName's last resort) */
    docs.headers.flatMap((h) => [h.salesperson_id, /^[0-9a-f-]{36}$/i.test(h.agent ?? '') ? h.agent : null]),
    (batch, from, to) => sb.from('staff').select('id, name, staff_code')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>,
  );
  if (staff.error) return { error: `staff: ${staff.error}` };
  const staffName = (id: string): string | null => {
    const s = staff.byId.get(id);
    return s ? (s.name || s.staff_code || null) : null;
  };

  const rows: SoLineExportCell[][] = [];
  for (const header of docs.headers) {
    const lines = [...(docs.linesByHeader.get(header.id) ?? [])].sort(byLinePosition);
    const b = baseByDoc.get(header.doc_no);
    const delivered = deliveredByDoc.get(header.doc_no) ?? 0;
    const remaining = remainingByDoc.get(header.doc_no) ?? 0;
    const deliveryState: SoDeliveryState = delivered <= 0 ? 'none' : remaining > 0 ? 'partial' : 'full';
    const statusWord = soListStatusWord(header.status, deliveryState, lifecycle.get(header.doc_no) ?? 'none', header.on_hold ?? null);
    const salesperson = soSalespersonName(header.agent, header.salesperson_id, staffName);
    for (const line of lines) {
      const d = deliverable.get(line.id);
      const lineWh = line.warehouse_id ? wh.byId.get(line.warehouse_id) : null;
      rows.push(soLineExportCells(header, line, {
        acDocNo: b?.linked_ac_docno ?? null,
        deliveryAddress: [b?.delivery_address1 ?? null, b?.delivery_address2 ?? null, b?.delivery_address3 ?? null, b?.delivery_address4 ?? null],
        statusWord,
        /* AutoCount's SHORT code (`KL`, owner 2026-09-15) through the
           write-back's own LOCATION_MAP, from the line's warehouse; a line with
           no warehouse keeps its stored location text, which already holds the
           book's code. */
        location: bookSpellingOrOwn(warehouseLabel(lineWh) ?? line.location, LOCATION_MAP),
        salesperson,
        delivered: d ? d.delivered : null,
        returned: d ? d.returned : null,
        remaining: d ? d.remaining : null,
        onDeliveryOrder: onDoByLine.get(line.id) ?? 0,
        doNos: [...(doNosByLine.get(line.id) ?? [])].sort(),
        poNos: [...(poNosByLine.get(line.id) ?? [])].sort(),
        poDeliveryDate: poDateByLine.get(line.id) ?? null,
      }));
    }
  }

  return {
    error: null,
    columns: SO_LINE_EXPORT_COLUMNS,
    rows,
    soCount: docs.headers.length,
    lineCount: rows.length,
    truncated: docs.truncated,
  };
}
