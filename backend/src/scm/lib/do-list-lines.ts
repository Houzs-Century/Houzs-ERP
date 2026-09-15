// ----------------------------------------------------------------------------
// do-list-lines — every line of a set of delivery orders, as the DO list shows
// and exports them (owner 2026-09-15: ONE Export, one row per line, the grid's
// columns, values as AutoCount holds them, NO prices).
//
// ONE reader for both the screen and the file: GET /delivery-orders-mfg?page=
// attaches `lines` to the page it returns, and GET
// /delivery-orders-mfg/export/rows attaches them to EVERY delivery order the
// list's filter matches. Both go through attachDoLines.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { lookupByIds, type ExportWindow } from './document-line-export';
import { chunkIn } from './paginate-all';
import { filterDoList, fromDoList, orderDoList, type DoListParams } from './do-list-read';
import { buildDoListRows, type DoListRowDeps } from './do-list-rows';
import { doLineRemaining } from './do-line-remaining';
import { warehouseLabel } from './warehouse-label';
import { bindingsFor } from './autocount-outbox';
import { buildVariantSummary } from '../shared/variant-summary';
import { bookSpellingOrOwn, resolveAcAgent, AC_DEBTOR_CODE } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { bookLineItem } from '../../services/autocount-book-item';
import type { DoBookHeader, DoListLine } from './do-line-export-columns';

/* No unit_price_sen / discount_sen / line_total_sen: the file carries no money,
   so the read does not fetch it either. */
export const DO_LINE_READ_COLS =
  'id, delivery_order_id, line_no, created_at, item_code, description, description2, variants, notes, item_group, uom, ' +
  'qty, m3_milli, line_delivery_date, so_item_id';

type LineRow = {
  id: string;
  delivery_order_id: string;
  line_no: number | null;
  created_at: string | null;
  item_code: string | null;
  description: string | null;
  description2: string | null;
  variants: unknown;
  notes: string | null;
  item_group: string | null;
  uom: string | null;
  qty: number | string | null;
  m3_milli: number | string | null;
  line_delivery_date: string | null;
  so_item_id: string | null;
};

type Res<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
type Q = {
  select(cols: string): Q;
  order(col: string, opts: { ascending: boolean; nullsFirst?: boolean }): Q;
  in(col: string, vals: string[]): Q;
  eq(col: string, val: unknown): Q;
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
   2026-09-15), the stored text only where the variants compose nothing — the same
   rule lib/so-list-lines.ts applies to a sales order line. */
function lineDescription2(itemGroup: string | null, variants: unknown, stored: string | null): string | null {
  const summary = variants && typeof variants === 'object' && !Array.isArray(variants)
    ? buildVariantSummary(itemGroup, variants as Record<string, unknown>).trim()
    : '';
  return summary || text(stored);
}

type HeaderFields = { id: string } & Record<string, unknown> & {
  do_number?: string | null;
  customer_delivery_date?: string | null;
  debtor_code?: string | null;
  agent?: string | null;
  salesperson_id?: string | null;
  warehouse_id?: string | null;
  sales_location?: string | null;
  so_doc_no?: string | null;
};

/** Attach `lines` (DoListLine[], printed order) and the AutoCount header
 *  spellings (DoBookHeader) to each delivery order row. */
export async function attachDoLines(
  sbIn: unknown,
  c: CompanyScopeCtx,
  rows: HeaderFields[],
): Promise<{ error: string | null; lineCount: number }> {
  const sb = sbIn as Sb;
  const ids = [...new Set(rows.map((r) => r.id))];
  if (ids.length === 0) return { error: null, lineCount: 0 };

  /* The company predicate on the LINE read too: a parent id is not company
     scope (CLAUDE.md R105 b). */
  const lineRead = await chunkIn<LineRow>(ids, (batch, from, to) =>
    scopeToCompany(sb.from('delivery_order_items').select(DO_LINE_READ_COLS), c)
      .in('delivery_order_id', batch).order('delivery_order_id', { ascending: true }).order('id', { ascending: true })
      .range(from, to) as Res<never>);
  if (lineRead.error) return { error: `lines: ${lineRead.error.message}`, lineCount: 0 };
  const all = lineRead.data;

  /* AutoCount's number — not in the list's HEADER select. */
  const acNo = await lookupByIds<{ id: string; linked_ac_docno: string | null }>(ids, (batch, from, to) =>
    scopeToCompany(sb.from('delivery_orders').select('id, linked_ac_docno'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (acNo.error) return { error: `delivery order numbers: ${acNo.error}`, lineCount: 0 };

  /* Invoiced / Returned / Uninvoiced — the app's own Pending ledger. Fails closed. */
  const pending = await doLineRemaining(sb, ids, 'invoiceable');
  if (!pending.ok) return { error: `invoiced quantities: ${pending.reason}`, lineCount: 0 };

  type SiLine = { id: string; do_item_id: string | null; sales_invoice_id: string | null };
  const siLines = await chunkIn<SiLine>(all.map((l) => l.id), (batch, from, to) =>
    scopeToCompany(sb.from('sales_invoice_items').select('id, do_item_id, sales_invoice_id'), c)
      .in('do_item_id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (siLines.error) return { error: `sales invoice lines: ${siLines.error.message}`, lineCount: 0 };
  const sis = await lookupByIds<{ id: string; invoice_number: string | null; status: string | null }>(
    siLines.data.map((l) => l.sales_invoice_id),
    (batch, from, to) => scopeToCompany(sb.from('sales_invoices').select('id, invoice_number, status'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (sis.error) return { error: `sales invoices: ${sis.error}`, lineCount: 0 };
  const invoiceNos = new Map<string, Set<string>>();
  for (const l of siLines.data) {
    const si = l.sales_invoice_id ? sis.byId.get(l.sales_invoice_id) : undefined;
    if (!l.do_item_id || !si?.invoice_number || String(si.status ?? '').toUpperCase() === 'CANCELLED') continue;
    invoiceNos.set(l.do_item_id, (invoiceNos.get(l.do_item_id) ?? new Set()).add(si.invoice_number));
  }

  /* The Sales Order line each DO line was raised from (company-scoped), and the
     purchase orders raised for that SO line — AutoCount's "PO Doc No.". */
  const so = await lookupByIds<{ id: string; doc_no: string | null }>(
    all.map((l) => l.so_item_id),
    (batch, from, to) => scopeToCompany(sb.from('mfg_sales_order_items').select('id, doc_no'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (so.error) return { error: `sales order numbers: ${so.error}`, lineCount: 0 };
  type PoLine = { id: string; so_item_id: string | null; purchase_order_id: string | null };
  const soItemIds = [...new Set(all.map((l) => l.so_item_id).filter((x): x is string => !!x))];
  const poLines = await chunkIn<PoLine>(soItemIds, (batch, from, to) =>
    scopeToCompany(sb.from('purchase_order_items').select('id, so_item_id, purchase_order_id'), c)
      .in('so_item_id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (poLines.error) return { error: `purchase order lines: ${poLines.error.message}`, lineCount: 0 };
  const pos = await lookupByIds<{ id: string; po_number: string | null; status: string | null }>(
    poLines.data.map((l) => l.purchase_order_id),
    (batch, from, to) => scopeToCompany(sb.from('purchase_orders').select('id, po_number, status'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (pos.error) return { error: `purchase orders: ${pos.error}`, lineCount: 0 };
  const poNosBySoItem = new Map<string, Set<string>>();
  for (const l of poLines.data) {
    const p = l.purchase_order_id ? pos.byId.get(l.purchase_order_id) : undefined;
    if (!l.so_item_id || !p?.po_number || String(p.status ?? '').toUpperCase() === 'CANCELLED') continue;
    poNosBySoItem.set(l.so_item_id, (poNosBySoItem.get(l.so_item_id) ?? new Set()).add(p.po_number));
  }

  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(
    rows.map((r) => r.warehouse_id ?? null),
    (batch, from, to) => sb.from('warehouses').select('id, code, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (wh.error) return { error: `warehouses: ${wh.error}`, lineCount: 0 };
  const staff = await lookupByIds<{ id: string; name: string | null }>(
    rows.map((r) => r.salesperson_id ?? null),
    (batch, from, to) => sb.from('staff').select('id, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>);
  if (staff.error) return { error: `staff: ${staff.error}`, lineCount: 0 };

  let bindings: Map<string, string>;
  try {
    bindings = await bindingsFor(sb as never, (c.get('companyId') as number | undefined) ?? null, all.map((l) => l.item_code ?? ''));
  } catch (e) {
    return { error: `item bindings: ${(e as Error).message}`, lineCount: 0 };
  }

  const byDo = new Map<string, LineRow[]>();
  for (const l of all) byDo.set(l.delivery_order_id, [...(byDo.get(l.delivery_order_id) ?? []), l]);

  for (const r of rows) {
    const acDocNo = text(acNo.byId.get(r.id)?.linked_ac_docno);
    const inBook = acDocNo != null;
    const staffName = r.salesperson_id ? text(staff.byId.get(r.salesperson_id)?.name) : null;
    const book: DoBookHeader = {
      ac_doc_no: acDocNo ?? text(r.do_number),
      ac_debtor_code: inBook ? (text(r.debtor_code) ?? AC_DEBTOR_CODE) : text(r.debtor_code),
      ac_agent: inBook ? resolveAcAgent(r.agent, staffName) : (text(r.agent) ?? staffName),
    };
    /* The delivery warehouse lives on the DO header; AutoCount's short code. */
    const location = bookSpellingOrOwn(
      warehouseLabel(r.warehouse_id ? wh.byId.get(r.warehouse_id) : null) ?? text(r.sales_location), LOCATION_MAP);
    const lines: DoListLine[] = [...(byDo.get(r.id) ?? [])].sort(byLinePosition).map((l) => {
      const item = inBook
        ? bookLineItem({ itemCode: l.item_code, description: l.description, category: l.item_group, uom: l.uom }, null, { bindings })
        : null;
      const p = pending.lines.get(l.id);
      const m3 = num(l.m3_milli);
      return {
        id: l.id,
        line_no: l.line_no,
        item_code: item ? item.itemCode : text(l.item_code),
        erp_item_code: text(l.item_code),
        description: item ? item.description : text(l.description),
        description2: lineDescription2(l.item_group, l.variants, l.description2),
        item_group: item ? item.itemGroup : text(l.item_group),
        uom: item ? item.uom : text(l.uom),
        location,
        qty: num(l.qty) ?? 0,
        m3: m3 === null ? null : Number((m3 / 1000).toFixed(3)),
        delivery_date: ymd(l.line_delivery_date) ?? ymd(r.customer_delivery_date),
        remark: text(l.notes),
        invoiced_qty: p ? p.invoiced : null,
        returned_qty: p ? p.returned : null,
        uninvoiced_qty: p ? p.remaining : null,
        so_doc_no: (l.so_item_id ? text(so.byId.get(l.so_item_id)?.doc_no) : null) ?? text(r.so_doc_no),
        invoice_nos: [...(invoiceNos.get(l.id) ?? [])].sort(),
        po_nos: l.so_item_id ? [...(poNosBySoItem.get(l.so_item_id) ?? [])].sort() : [],
      };
    });
    Object.assign(r, book, { lines });
  }
  return { error: null, lineCount: all.length };
}

const ROW_PAGE = 100;

export type DoExportRows =
  | { error: string }
  | { error: null; deliveryOrders: Array<{ id: string } & Record<string, unknown>>; total: number; lineCount: number; next: number | null };

/** One WINDOW of the delivery orders the list's filter matches, in the list's
 *  own row shape (lib/do-list-rows.ts), each carrying `lines`. `next` is the
 *  offset of the following window, null after the last. */
export async function buildDoExportRows(
  sb: Variables['supabase'],
  c: Context<{ Bindings: Env; Variables: Variables }>,
  params: DoListParams,
  scopeIds: string[] | null,
  headerCols: string,
  deps: DoListRowDeps,
  window: ExportWindow,
): Promise<DoExportRows> {
  const head = await filterDoList(orderDoList(fromDoList(sb, headerCols), params.sort), params, c, scopeIds)
    .range(window.offset, window.offset + window.limit - 1);
  if (head.error) return { error: `delivery orders: ${head.error.message}` };
  const raw = (head.data ?? []) as unknown as Array<{ id: string } & Record<string, unknown>>;
  const out: Array<{ id: string } & Record<string, unknown>> = [];
  let lineCount = 0;
  for (let i = 0; i < raw.length; i += ROW_PAGE) {
    const page = await buildDoListRows(sb, c, raw.slice(i, i + ROW_PAGE), deps);
    const attached = await attachDoLines(sb, c, page);
    if (attached.error) return { error: attached.error };
    lineCount += attached.lineCount;
    out.push(...page);
  }
  return { error: null, deliveryOrders: out, total: out.length, lineCount, next: raw.length === window.limit ? window.offset + window.limit : null };
}
