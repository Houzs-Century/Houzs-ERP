// ----------------------------------------------------------------------------
// grn-export-rows — every Goods Received note the list's filter matches, in the
// list's own row shape, each carrying its LINES, for the grid-driven export
// (GET /grns/export/rows, routes/grn-exports.ts).
//
// Owner 2026-09-15: ONE Export on the list, one spreadsheet row per line, the
// grid's visible columns, AutoCount's Detail Listing labels and values. The
// page decides the columns; this module supplies the values a column may need,
// each spelled the way AutoCount's listing spells it where the ERP can know it:
//   - ac_doc_no      the AutoCount GR number (linked_ac_gr_docno on a migrated
//                    receipt, whose linked_ac_docno holds the PO number)
//   - ac_item_code   resolveAcItemCode with the live bindings — the write-back's
//                    own resolution, never a copy. A sofa PIECE keeps its own
//                    row and code (owner 2026-09-15), where the book holds one
//                    set line.
//   - location       AutoCount's short code through LOCATION_MAP
//   - description2   lib/line-export-description2.ts (the owner's variant rule)
//   - our_po_no      the purchase order's AutoCount number (AutoCount's
//                    "Our PO No."), po_no the ERP's
//   - invoiced_qty   the live Σ of purchase invoice lines, not the stored
//                    migrated figure (owner 2026-09-15)
//
// Read path: headers through the list's filter + sort, paged to the ceiling
// (document-line-export.ts); lines by header id in URL-sized batches; every
// read company-scoped (R105).
// ----------------------------------------------------------------------------

import { activeCompanyId, scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { lookupByIds } from './document-line-export';
import { pageWithTruncation } from './outstanding-po-lines';
import { chunkIn } from './paginate-all';
import { GRN_HEADER_COLS, filterGrnList, orderGrnList, type GrnListFilters } from './grn-list-read';
import { bookLineItem, type BookLineItem } from '../../services/autocount-book-item';
import { lineExportDescription2 } from './line-export-description2';
import { warehouseLabel } from './warehouse-label';
import { bindingsFor } from './autocount-outbox';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank, type RawSoDisplayLine } from '../shared/so-line-display';

/* Which purchase invoices count as having billed a receipt line: the rule
   recomputeGrnInvoiced (routes/purchase-invoices.ts) recounts the stored
   counter by — a DRAFT consumes nothing until confirmed, a CANCELLED one gave
   its quantity back. */
export const GRN_INVOICED_EXCLUDED_PI_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'CANCELLED']);

/* The list's header columns and the two embeds its grid reads (supplier, PO),
   plus the AutoCount number columns. NOT the list's FK-hinted warehouse embed:
   no grid column reads it (Location comes per line, below), and the read-only
   production check's PostgREST stand-in cannot run an FK hint. */
export const GRN_EXPORT_ROWS_SELECT =
  `${GRN_HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_order:purchase_orders(id, po_number), ` +
  'linked_ac_docno, linked_ac_gr_docno, migrated_no_stock';

const LINE_COLS =
  'id, grn_id, created_at, purchase_order_item_id, item_code, supplier_sku, material_name, description, description2, ' +
  'notes, item_group, uom, qty_received, qty_accepted, qty_rejected, returned_qty, unit_price_sen, discount_sen, line_total_sen, ' +
  'delivery_date, variants';

export type GrnExportLine = {
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
  qty_received: number;
  qty_rejected: number;
  invoiced_qty: number;
  returned_qty: number;
  uninvoiced_qty: number;
  unit_price_sen: number | null;
  discount_sen: number | null;
  line_total_sen: number | null;
  delivery_date: string | null;
  po_no: string | null;
  our_po_no: string | null;
  so_doc_no: string | null;
  invoice_nos: string | null;
};

type HeaderRow = { id: string; supplier_id?: string | null; warehouse_id?: string | null; supplier?: { code?: string | null } | null } & Record<string, unknown>;
type RawLine = {
  id: string;
  grn_id: string;
  created_at: string | null;
  purchase_order_item_id: string | null;
  item_code: string | null;
  supplier_sku: string | null;
  material_name: string | null;
  description: string | null;
  description2: string | null;
  notes: string | null;
  item_group: string | null;
  uom: string | null;
  qty_received: number | string | null;
  qty_accepted: number | string | null;
  qty_rejected: number | string | null;
  returned_qty: number | string | null;
  unit_price_sen: number | string | null;
  discount_sen: number | string | null;
  line_total_sen: number | string | null;
  delivery_date: string | null;
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
  filter(col: string, op: string, val: string): Q;
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
const day = (v: unknown): string | null => {
  const s = text(v);
  return s ? s.slice(0, 10) : null;
};

/* WHICH COLUMN HOLDS THE AUTOCOUNT GR NUMBER. On a receipt migrated from the
   book (`migrated_no_stock`), `linked_ac_docno` holds the AutoCount PURCHASE
   ORDER number and the GR number sits in `linked_ac_gr_docno` (migration
   20260907T2345_grn_linked_ac_gr_docno.sql); on a receipt the ERP created,
   `linked_ac_docno` IS the GR number. A migrated receipt with no GR number
   has none, never its PO number. Measured 2026-09-15: 791 / 791 paired lines
   equal AutoCount's Doc No. */
export function grnAcDocNo(h: Record<string, unknown>): string | null {
  return h.migrated_no_stock === true ? text(h.linked_ac_gr_docno) : text(h.linked_ac_docno);
}

/* The receipt detail page's line order: creation, category rank, sofa build. */
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

export type GrnRowsWithLines<H> =
  | { error: string }
  | { error: null; rows: Array<H & { ac_doc_no: string | null; lines: GrnExportLine[] }>; lineCount: number };

/**
 * Attach every line of the given grns rows, each value in AutoCount's spelling
 * where the ERP can know it. ONE function for the list page (GET / with `page`)
 * and GET /export/rows, so a line column shows on screen exactly what the file
 * holds. Lines by header id in URL-sized batches, company predicate on the LINE
 * read and on every lookup (R105).
 */
export async function attachGrnLines<H extends HeaderRow>(sbIn: unknown, c: CompanyScopeCtx, headers: H[]): Promise<GrnRowsWithLines<H>> {
  const sb = sbIn as Sb;
  const lineRead = await chunkIn<RawLine>([...new Set(headers.map((h) => h.id))], (batch, from, to) =>
    scopeToCompany(sb.from('grn_items').select(LINE_COLS), c)
      .in('grn_id', batch)
      .order('grn_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to) as Rows<RawLine>);
  if (lineRead.error) return { error: `lines: ${lineRead.error.message}` };
  const allLines = lineRead.data;
  const linesByHeader = new Map<string, RawLine[]>();
  for (const l of allLines) {
    const group = linesByHeader.get(l.grn_id);
    if (group) group.push(l); else linesByHeader.set(l.grn_id, [l]);
  }

  type PoLine = { id: string; purchase_order_id: string | null; so_item_id: string | null };
  const poLines = await lookupByIds<PoLine>(allLines.map((l) => l.purchase_order_item_id), (batch, from, to) =>
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

  type PiLine = { id: string; purchase_invoice_id: string | null; grn_item_id: string | null; qty: number | string | null };
  const piLines = await chunkIn<PiLine>(allLines.map((l) => l.id), (batch, from, to) =>
    scopeToCompany(sb.from('purchase_invoice_items').select('id, purchase_invoice_id, grn_item_id, qty'), c)
      .in('grn_item_id', batch).order('id', { ascending: true }).range(from, to) as Rows<PiLine>);
  if (piLines.error) return { error: `purchase invoice lines: ${piLines.error.message}` };

  const pis = await lookupByIds<{ id: string; invoice_number: string | null; status: string | null }>(
    piLines.data.map((l) => l.purchase_invoice_id), (batch, from, to) =>
      scopeToCompany(sb.from('purchase_invoices').select('id, invoice_number, status'), c)
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; invoice_number: string | null; status: string | null }>);
  if (pis.error) return { error: `purchase invoices: ${pis.error}` };

  const billed = new Map<string, { qty: number; numbers: string[] }>();
  for (const pl of piLines.data) {
    if (!pl.grn_item_id || !pl.purchase_invoice_id) continue;
    const pi = pis.byId.get(pl.purchase_invoice_id);
    if (!pi || GRN_INVOICED_EXCLUDED_PI_STATUSES.has(String(pi.status ?? '').toUpperCase())) continue;
    const acc = billed.get(pl.grn_item_id) ?? { qty: 0, numbers: [] };
    acc.qty += num(pl.qty) ?? 0;
    const no = (pi.invoice_number ?? '').trim();
    if (no && !acc.numbers.includes(no)) acc.numbers.push(no);
    billed.set(pl.grn_item_id, acc);
  }

  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(headers.map((h) => h.warehouse_id), (batch, from, to) =>
    sb.from('warehouses').select('id, code, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; code: string | null; name: string | null }>);
  if (wh.error) return { error: `warehouses: ${wh.error}` };

  /* The write-back's item-code resolution: the bindings for each receipt's
     supplier (its own supplier's binding wins), then resolveAcItemCode. */
  const companyId = activeCompanyId(c) ?? null;
  const bookItem = new Map<string, BookLineItem>();
  const bySupplier = new Map<string, RawLine[]>();
  const supplierOf = new Map<string, HeaderRow>();
  for (const h of headers) supplierOf.set(h.id, h);
  for (const l of allLines) {
    const k = String(supplierOf.get(l.grn_id)?.supplier_id ?? '');
    const group = bySupplier.get(k);
    if (group) group.push(l); else bySupplier.set(k, [l]);
  }
  try {
    for (const [supplierId, group] of bySupplier) {
      const bindings = await bindingsFor(sb as never, companyId, group.map((l) => l.item_code ?? ''), supplierId || null);
      for (const l of group) {
        const supplierCode = supplierOf.get(l.grn_id)?.supplier?.code ?? null;
        bookItem.set(l.id, bookLineItem({ itemCode: l.item_code, description: text(l.material_name) ?? text(l.description), category: l.item_group, uom: l.uom }, supplierCode, { bindings }));
      }
    }
  } catch (e) {
    return { error: `item code bindings: ${(e as Error).message}` };
  }

  const rows = headers.map((h) => {
    const location = bookSpellingOrOwn(warehouseLabel(h.warehouse_id ? wh.byId.get(h.warehouse_id) : null), LOCATION_MAP);
    const lines = inDetailOrder(linesByHeader.get(h.id) ?? []).map((l): GrnExportLine => {
      const poLine = l.purchase_order_item_id ? poLines.byId.get(l.purchase_order_item_id) : undefined;
      const po = poLine?.purchase_order_id ? pos.byId.get(poLine.purchase_order_id) : undefined;
      const bill = billed.get(l.id);
      const qty = num(l.qty_accepted) ?? 0;
      const invoiced = bill?.qty ?? 0;
      const returned = num(l.returned_qty) ?? 0;
      return {
        id: l.id,
        item_code: text(l.item_code),
        ...bookFieldsOf(bookItem.get(l.id)),
        supplier_sku: text(l.supplier_sku),
        description: text(l.material_name) ?? text(l.description),
        description2: lineExportDescription2(l.item_group, l.variants, l.description2),
        remarks: text(l.notes),
        item_group: text(l.item_group),
        uom: text(l.uom),
        location,
        qty,
        qty_received: num(l.qty_received) ?? 0,
        qty_rejected: num(l.qty_rejected) ?? 0,
        invoiced_qty: invoiced,
        returned_qty: returned,
        uninvoiced_qty: Number((qty - invoiced - returned).toFixed(4)),
        unit_price_sen: num(l.unit_price_sen),
        discount_sen: num(l.discount_sen),
        line_total_sen: num(l.line_total_sen),
        delivery_date: day(l.delivery_date),
        po_no: text(po?.po_number),
        our_po_no: text(po?.linked_ac_docno),
        so_doc_no: poLine?.so_item_id ? text(so.byId.get(poLine.so_item_id)?.doc_no) : null,
        invoice_nos: bill && bill.numbers.length > 0 ? bill.numbers.join(', ') : null,
      };
    });
    return { ...h, ac_doc_no: grnAcDocNo(h), lines };
  });

  return { error: null, rows, lineCount: allLines.length };
}

export type GrnExportRows =
  | { error: string }
  | { error: null; rows: Array<HeaderRow & { ac_doc_no: string | null; lines: GrnExportLine[] }>; lineCount: number; truncated: boolean };

/** Every grns row the list's filter matches (all pages, stopped at the
 *  ceiling with `truncated`), each with its lines — GET /export/rows. */
export async function readGrnExportRows(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: GrnListFilters,
): Promise<GrnExportRows> {
  const sb = sbIn as Sb;
  const head = await pageWithTruncation<HeaderRow>((from, to) =>
    orderGrnList(filterGrnList(sb.from('grns').select(GRN_EXPORT_ROWS_SELECT), filters, c), filters.sort).range(from, to));
  if (head.error) return { error: `headers: ${head.error.message}` };
  const out = await attachGrnLines(sb, c, head.data ?? []);
  if (out.error !== null) return { error: out.error };
  return { error: null, rows: out.rows, lineCount: out.lineCount, truncated: head.truncated };
}
