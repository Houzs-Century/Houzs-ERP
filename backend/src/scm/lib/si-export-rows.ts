// ----------------------------------------------------------------------------
// si-export-rows — every Sales Invoice the list's filter AND the caller's sales
// scope match, each carrying its LINES, for the grid-driven export
// (GET /sales-invoices/export/rows, routes/sales-invoice-exports.ts, which also
// stamps the list's derived header columns and strips the finance keys).
//
// Owner 2026-09-15: ONE Export, one spreadsheet row per line, the grid's
// visible columns, AutoCount's Detail Listing labels and values. Measured
// against the book the same day (runs 34946202589, 34947753794):
//   - ac_agent      resolveAcAgent(agent, salesperson name), UPPER-CASED — the
//                   book stores agent codes in capitals ("CHEA HUAN"); 78 of 223
//                   paired lines are migrated invoices with no agent at all, a
//                   data gap this does not fill
//   - ac_item_code  resolveAcItemCode + bindings (193 / 198 non-sofa lines)
//   - do_no / location  through the DO LINE: sales_invoice_items.so_item_id is
//                   empty on every production line
//   - description2  lib/line-export-description2.ts (the owner's variant rule)
// ----------------------------------------------------------------------------

import { activeCompanyId, scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { readDocumentsWithLines, lookupByIds } from './document-line-export';
import { SI_HEADER_COLS, filterSiList, orderSiList, type SiListFilters } from './si-list-read';
import { lineExportDescription2 } from './line-export-description2';
import { warehouseLabel } from './warehouse-label';
import { bindingsFor } from './autocount-outbox';
import { bookSpellingOrOwn, resolveAcAgent } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { resolveAcItemCode } from '../../services/autocount-item-code';

export const SI_EXPORT_ROWS_SELECT = `${SI_HEADER_COLS}, linked_ac_docno`;

const LINE_COLS =
  'id, sales_invoice_id, line_no, created_at, do_item_id, item_code, item_group, description, description2, notes, ' +
  'uom, qty, unit_price_sen, discount_sen, line_total_sen, line_delivery_date, variants';

export type SiExportLine = {
  id: string;
  item_code: string | null;
  ac_item_code: string | null;
  description: string | null;
  description2: string | null;
  remarks: string | null;
  item_group: string | null;
  uom: string | null;
  location: string | null;
  qty: number;
  unit_price_sen: number | null;
  discount_sen: number | null;
  line_total_sen: number | null;
  delivery_date: string | null;
  do_no: string | null;
};

type HeaderRow = { id: string; salesperson_id?: string | null; agent?: string | null; sales_location?: string | null } & Record<string, unknown>;
type RawLine = {
  id: string;
  sales_invoice_id: string;
  line_no: number | null;
  created_at: string | null;
  do_item_id: string | null;
  item_code: string | null;
  item_group: string | null;
  description: string | null;
  description2: string | null;
  notes: string | null;
  uom: string | null;
  qty: number | string | null;
  unit_price_sen: number | string | null;
  discount_sen: number | string | null;
  line_total_sen: number | string | null;
  line_delivery_date: string | null;
  variants: unknown;
};

type QueryError = { message: string } | null;
type Rows<T> = PromiseLike<{ data: T[] | null; error: QueryError }>;
type Q = {
  select(cols: string): Q;
  order(col: string, opts: { ascending: boolean; nullsFirst?: boolean }): Q;
  in(col: string, vals: string[]): Q;
  eq(col: string, val: unknown): Q;
  or(filters: string): Q;
  gte(col: string, val: unknown): Q;
  lte(col: string, val: unknown): Q;
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: QueryError }>;
};
type Sb = { from(table: string): Q };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

/* The invoice detail page's line order: line_no (blank last), creation, id. */
const byLinePosition = (a: RawLine, b: RawLine): number => {
  const an = a.line_no ?? Infinity;
  const bn = b.line_no ?? Infinity;
  if (an !== bn) return an < bn ? -1 : 1;
  const ac = a.created_at ?? '';
  const bc = b.created_at ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** AutoCount's Sales Agent as the book spells it: the write-back's own
 *  resolution, in capitals. */
export function siExportAgent(agent: string | null | undefined, salespersonName: string | null): string | null {
  const resolved = resolveAcAgent(agent, salespersonName);
  return resolved ? resolved.toUpperCase() : null;
}

export type SiExportRows =
  | { error: string }
  | { error: null; rows: Array<HeaderRow & { ac_agent: string | null; lines: SiExportLine[] }>; lineCount: number; truncated: boolean };

export async function readSiExportRows(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: SiListFilters,
  scopeIds: string[] | null,
): Promise<SiExportRows> {
  const sb = sbIn as Sb;
  const read = await readDocumentsWithLines<HeaderRow, RawLine>({
    headers: (from, to) =>
      orderSiList(filterSiList(sb.from('sales_invoices').select(SI_EXPORT_ROWS_SELECT), filters, c, scopeIds), filters.sort).range(from, to),
    lines: (batch, from, to) =>
      scopeToCompany(sb.from('sales_invoice_items').select(LINE_COLS), c)
        .in('sales_invoice_id', batch)
        .order('sales_invoice_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as Rows<RawLine>,
    parentOf: (l) => l.sales_invoice_id,
  });
  if (read.error !== null) return { error: read.error };
  const allLines = [...read.linesByHeader.values()].flat();

  type DoLine = { id: string; delivery_order_id: string | null };
  const doLines = await lookupByIds<DoLine>(allLines.map((l) => l.do_item_id), (batch, from, to) =>
    scopeToCompany(sb.from('delivery_order_items').select('id, delivery_order_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<DoLine>);
  if (doLines.error) return { error: `delivery order lines: ${doLines.error}` };

  type DoHead = { id: string; do_number: string | null; warehouse_id: string | null; sales_location: string | null };
  const dos = await lookupByIds<DoHead>([...doLines.byId.values()].map((d) => d.delivery_order_id), (batch, from, to) =>
    scopeToCompany(sb.from('delivery_orders').select('id, do_number, warehouse_id, sales_location'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<DoHead>);
  if (dos.error) return { error: `delivery orders: ${dos.error}` };

  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>([...dos.byId.values()].map((d) => d.warehouse_id), (batch, from, to) =>
    sb.from('warehouses').select('id, code, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; code: string | null; name: string | null }>);
  if (wh.error) return { error: `warehouses: ${wh.error}` };

  /* Salesperson names, by ids of invoices already read under the company and
     sales scope — the staff read the Sales Invoice Detail Listing makes. */
  const staff = await lookupByIds<{ id: string; name: string | null }>(read.headers.map((h) => h.salesperson_id), (batch, from, to) =>
    sb.from('staff').select('id, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; name: string | null }>);
  if (staff.error) return { error: `salespeople: ${staff.error}` };

  /* A sales invoice has no supplier to narrow an item code by, exactly as the
     write-back resolves an IV line. */
  const acCode = new Map<string, string | null>();
  try {
    const bindings = await bindingsFor(sb as never, activeCompanyId(c) ?? null, allLines.map((l) => l.item_code ?? ''));
    for (const l of allLines) {
      const res = l.item_code ? resolveAcItemCode(l.item_code, { bindings }) : null;
      acCode.set(l.id, res && res.ok ? res.acItemCode : null);
    }
  } catch (e) {
    return { error: `item code bindings: ${(e as Error).message}` };
  }

  const rows = read.headers.map((h) => ({
    ...h,
    ac_agent: siExportAgent(h.agent, h.salesperson_id ? staff.byId.get(h.salesperson_id)?.name ?? null : null),
    lines: [...(read.linesByHeader.get(h.id) ?? [])].sort(byLinePosition).map((l): SiExportLine => {
      const doLine = l.do_item_id ? doLines.byId.get(l.do_item_id) : undefined;
      const delivery = doLine?.delivery_order_id ? dos.byId.get(doLine.delivery_order_id) : undefined;
      /* Where the goods shipped from: the delivery order's warehouse, else the
         location that delivery order was sold from, else the invoice's own. */
      const place = warehouseLabel(delivery?.warehouse_id ? wh.byId.get(delivery.warehouse_id) : null)
        ?? text(delivery?.sales_location)
        ?? text(h.sales_location);
      return {
        id: l.id,
        item_code: text(l.item_code),
        ac_item_code: acCode.get(l.id) ?? null,
        description: text(l.description),
        description2: lineExportDescription2(l.item_group, l.variants, l.description2),
        remarks: text(l.notes),
        item_group: text(l.item_group),
        uom: text(l.uom),
        location: bookSpellingOrOwn(place, LOCATION_MAP),
        qty: num(l.qty) ?? 0,
        unit_price_sen: num(l.unit_price_sen),
        discount_sen: num(l.discount_sen),
        line_total_sen: num(l.line_total_sen),
        delivery_date: text(l.line_delivery_date)?.slice(0, 10) ?? null,
        do_no: text(delivery?.do_number),
      };
    }),
  }));

  return { error: null, rows, lineCount: allLines.length, truncated: read.truncated };
}
