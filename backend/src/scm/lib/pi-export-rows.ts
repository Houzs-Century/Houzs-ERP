// ----------------------------------------------------------------------------
// pi-export-rows — every Purchase Invoice the list's filter matches, in the
// list's own row shape, each carrying its LINES, for the grid-driven export
// (GET /purchase-invoices/export/rows, routes/purchase-invoice-exports.ts).
//
// Owner 2026-09-15: ONE Export, one spreadsheet row per line, the grid's
// visible columns, AutoCount's Detail Listing labels and values. The invoice
// line carries no SKU, warehouse or PO of its own, so those come through the
// goods-received line it bills. Values spelled as AutoCount's listing does
// where the ERP can know it (measured against the book 2026-09-15, run
// 34947753794):
//   - ac_item_code  resolveAcItemCode + bindings (357 / 357 non-sofa lines)
//   - location      the GRN warehouse's short code (437 / 437)
//   - our_po_no     the purchase order's AutoCount number (437 / 437)
//   - description2  lib/line-export-description2.ts (the owner's variant rule)
// ----------------------------------------------------------------------------

import { activeCompanyId, scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { lookupByIds } from './document-line-export';
import { pageWithTruncation } from './outstanding-po-lines';
import { chunkIn } from './paginate-all';
import { PI_LIST_SELECT, filterPiList, orderPiList, type PiListFilters } from './pi-list-read';
import { lineExportDescription2 } from './line-export-description2';
import { warehouseLabel } from './warehouse-label';
import { bindingsFor } from './autocount-outbox';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { bookLineItem, type BookLineItem } from '../../services/autocount-book-item';
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank, type RawSoDisplayLine } from '../shared/so-line-display';

export const PI_EXPORT_ROWS_SELECT = PI_LIST_SELECT;

const LINE_COLS =
  'id, purchase_invoice_id, created_at, grn_item_id, item_code, material_name, description, description2, notes, ' +
  'item_group, uom, qty, po_unit_price_sen, unit_price_sen, discount_sen, line_total_sen, variants';

export type PiExportLine = {
  id: string;
  /** The book's Item Description / Item Group / UOM for this line's item
   *  (services/autocount-book-item.ts), the ERP's own values where the book has
   *  no item for the code. */
  book_description: string | null;
  book_item_group: string | null;
  book_uom: string | null;
  item_code: string | null;
  ac_item_code: string | null;
  supplier_sku: string | null;
  description: string | null;
  description2: string | null;
  remarks: string | null;
  item_group: string | null;
  uom: string | null;
  location: string | null;
  qty: number;
  po_unit_price_sen: number | null;
  unit_price_sen: number | null;
  discount_sen: number | null;
  line_total_sen: number | null;
  grn_no: string | null;
  po_no: string | null;
  our_po_no: string | null;
  so_doc_no: string | null;
};

type HeaderRow = { id: string; supplier_id?: string | null; supplier?: { code?: string | null } | null } & Record<string, unknown>;
type RawLine = {
  id: string;
  purchase_invoice_id: string;
  created_at: string | null;
  grn_item_id: string | null;
  item_code: string | null;
  material_name: string | null;
  description: string | null;
  description2: string | null;
  notes: string | null;
  item_group: string | null;
  uom: string | null;
  qty: number | string | null;
  po_unit_price_sen: number | string | null;
  unit_price_sen: number | string | null;
  discount_sen: number | string | null;
  line_total_sen: number | string | null;
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

const bookFieldsOf = (b: BookLineItem | undefined) => ({
  ac_item_code: b?.itemCode ?? null,
  book_description: b?.description ?? null,
  book_item_group: b?.itemGroup ?? null,
  book_uom: b?.uom ?? null,
});
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

/* The invoice detail page's line order: creation, category rank, sofa build. */
function inDetailOrder(lines: RawLine[]): RawLine[] {
  const byCreation = [...lines].sort((a, b) => {
    const ac = a.created_at ?? '';
    const bc = b.created_at ?? '';
    if (ac !== bc) return ac < bc ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const ranked = sortSoLinesByGroupRank(byCreation, (l) => l.item_group);
  return orderSofaModuleRowsWithinBuilds(ranked as unknown as RawSoDisplayLine[]) as unknown as RawLine[];
}

export type PiRowsWithLines<H> =
  | { error: string }
  | { error: null; rows: Array<H & { lines: PiExportLine[] }>; lineCount: number };

/**
 * Attach every line of the given purchase_invoices rows, each value in AutoCount's spelling
 * where the ERP can know it. ONE function for the list page (GET / with `page`)
 * and GET /export/rows, so a line column shows on screen exactly what the file
 * holds. Lines by header id in URL-sized batches, company predicate on the LINE
 * read and on every lookup (R105).
 */
export async function attachPiLines<H extends HeaderRow>(sbIn: unknown, c: CompanyScopeCtx, headers: H[]): Promise<PiRowsWithLines<H>> {
  const sb = sbIn as Sb;
  const lineRead = await chunkIn<RawLine>([...new Set(headers.map((h) => h.id))], (batch, from, to) =>
    scopeToCompany(sb.from('purchase_invoice_items').select(LINE_COLS), c)
      .in('purchase_invoice_id', batch)
      .order('purchase_invoice_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to) as Rows<RawLine>);
  if (lineRead.error) return { error: `lines: ${lineRead.error.message}` };
  const allLines = lineRead.data;
  const linesByHeader = new Map<string, RawLine[]>();
  for (const l of allLines) {
    const group = linesByHeader.get(l.purchase_invoice_id);
    if (group) group.push(l); else linesByHeader.set(l.purchase_invoice_id, [l]);
  }

  type GrnLine = { id: string; grn_id: string | null; supplier_sku: string | null; purchase_order_item_id: string | null };
  const grnLines = await lookupByIds<GrnLine>(allLines.map((l) => l.grn_item_id), (batch, from, to) =>
    scopeToCompany(sb.from('grn_items').select('id, grn_id, supplier_sku, purchase_order_item_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<GrnLine>);
  if (grnLines.error) return { error: `goods received lines: ${grnLines.error}` };

  type Grn = { id: string; grn_number: string | null; warehouse_id: string | null };
  const grns = await lookupByIds<Grn>([...grnLines.byId.values()].map((g) => g.grn_id), (batch, from, to) =>
    scopeToCompany(sb.from('grns').select('id, grn_number, warehouse_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<Grn>);
  if (grns.error) return { error: `goods received notes: ${grns.error}` };

  type PoLine = { id: string; purchase_order_id: string | null; so_item_id: string | null };
  const poLines = await lookupByIds<PoLine>([...grnLines.byId.values()].map((g) => g.purchase_order_item_id), (batch, from, to) =>
    scopeToCompany(sb.from('purchase_order_items').select('id, purchase_order_id, so_item_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<PoLine>);
  if (poLines.error) return { error: `purchase order lines: ${poLines.error}` };

  type Po = { id: string; po_number: string | null; linked_ac_docno: string | null };
  const pos = await lookupByIds<Po>([...poLines.byId.values()].map((l) => l.purchase_order_id), (batch, from, to) =>
    scopeToCompany(sb.from('purchase_orders').select('id, po_number, linked_ac_docno'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<Po>);
  if (pos.error) return { error: `purchase orders: ${pos.error}` };

  const so = await lookupByIds<{ id: string; doc_no: string | null }>([...poLines.byId.values()].map((l) => l.so_item_id), (batch, from, to) =>
    scopeToCompany(sb.from('mfg_sales_order_items').select('id, doc_no'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; doc_no: string | null }>);
  if (so.error) return { error: `sales order numbers: ${so.error}` };

  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>([...grns.byId.values()].map((g) => g.warehouse_id), (batch, from, to) =>
    sb.from('warehouses').select('id, code, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; code: string | null; name: string | null }>);
  if (wh.error) return { error: `warehouses: ${wh.error}` };

  const companyId = activeCompanyId(c) ?? null;
  const headerOf = new Map(headers.map((h) => [h.id, h]));
  const bySupplier = new Map<string, RawLine[]>();
  for (const l of allLines) {
    const k = String(headerOf.get(l.purchase_invoice_id)?.supplier_id ?? '');
    const group = bySupplier.get(k);
    if (group) group.push(l); else bySupplier.set(k, [l]);
  }
  const bookItem = new Map<string, BookLineItem>();
  try {
    for (const [supplierId, group] of bySupplier) {
      const bindings = await bindingsFor(sb as never, companyId, group.map((l) => l.item_code ?? ''), supplierId || null);
      for (const l of group) {
        const supplierCode = headerOf.get(l.purchase_invoice_id)?.supplier?.code ?? null;
        bookItem.set(l.id, bookLineItem({ itemCode: l.item_code, description: text(l.material_name) ?? text(l.description), category: l.item_group, uom: l.uom }, supplierCode, { bindings }));
      }
    }
  } catch (e) {
    return { error: `item code bindings: ${(e as Error).message}` };
  }

  const rows = headers.map((h) => ({
    ...h,
    lines: inDetailOrder(linesByHeader.get(h.id) ?? []).map((l): PiExportLine => {
      const g = l.grn_item_id ? grnLines.byId.get(l.grn_item_id) : undefined;
      const receipt = g?.grn_id ? grns.byId.get(g.grn_id) : undefined;
      const poLine = g?.purchase_order_item_id ? poLines.byId.get(g.purchase_order_item_id) : undefined;
      const po = poLine?.purchase_order_id ? pos.byId.get(poLine.purchase_order_id) : undefined;
      return {
        id: l.id,
        item_code: text(l.item_code),
        ...bookFieldsOf(bookItem.get(l.id)),
        supplier_sku: text(g?.supplier_sku),
        description: text(l.material_name) ?? text(l.description),
        description2: lineExportDescription2(l.item_group, l.variants, l.description2),
        remarks: text(l.notes),
        item_group: text(l.item_group),
        uom: text(l.uom),
        location: bookSpellingOrOwn(warehouseLabel(receipt?.warehouse_id ? wh.byId.get(receipt.warehouse_id) : null), LOCATION_MAP),
        qty: num(l.qty) ?? 0,
        po_unit_price_sen: num(l.po_unit_price_sen),
        unit_price_sen: num(l.unit_price_sen),
        discount_sen: num(l.discount_sen),
        line_total_sen: num(l.line_total_sen),
        grn_no: text(receipt?.grn_number),
        po_no: text(po?.po_number),
        our_po_no: text(po?.linked_ac_docno),
        so_doc_no: poLine?.so_item_id ? text(so.byId.get(poLine.so_item_id)?.doc_no) : null,
      };
    }),
  }));

  return { error: null, rows, lineCount: allLines.length };
}

export type PiExportRows =
  | { error: string }
  | { error: null; rows: Array<HeaderRow & { lines: PiExportLine[] }>; lineCount: number; truncated: boolean };

/** Every purchase_invoices row the list's filter matches (all pages, stopped at the
 *  ceiling with `truncated`), each with its lines — GET /export/rows. */
export async function readPiExportRows(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: PiListFilters,
): Promise<PiExportRows> {
  const sb = sbIn as Sb;
  const head = await pageWithTruncation<HeaderRow>((from, to) =>
    orderPiList(filterPiList(sb.from('purchase_invoices').select(PI_EXPORT_ROWS_SELECT), filters, c), filters.sort).range(from, to));
  if (head.error) return { error: `headers: ${head.error.message}` };
  const out = await attachPiLines(sb, c, head.data ?? []);
  if (out.error !== null) return { error: out.error };
  return { error: null, rows: out.rows, lineCount: out.lineCount, truncated: head.truncated };
}
