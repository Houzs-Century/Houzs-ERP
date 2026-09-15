// ----------------------------------------------------------------------------
// grn-line-export — the Goods Received plug-in for document-line-export.
//
// Every line of every receipt the GRN list's CURRENT tab, search and sort match,
// across all pages, shaped as the columns in grn-line-export-columns.ts.
// Read by GET /grns/export/lines (routes/grn-exports.ts).
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { readDocumentsWithLines, lookupByIds } from './document-line-export';
import { chunkIn } from './paginate-all';
import { filterGrnList, orderGrnList, type GrnListFilters } from './grn-list-read';
import { warehouseLabel } from './warehouse-label';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank, type RawSoDisplayLine } from '../shared/so-line-display';
import {
  GRN_LINE_EXPORT_COLUMNS,
  grnLineExportCells,
  type GrnExportHeader,
  type GrnExportLine,
  type GrnLineExportCell,
} from './grn-line-export-columns';

export const GRN_EXPORT_HEADER_COLS =
  'id, grn_number, received_at, status, on_hold, delivery_note_ref, currency, warehouse_id, ' +
  'linked_ac_docno, linked_ac_gr_docno, migrated_no_stock, supplier:suppliers(code, name)';

export const GRN_EXPORT_LINE_COLS =
  'id, grn_id, created_at, purchase_order_item_id, item_code, supplier_sku, material_name, description, description2, ' +
  'notes, item_group, uom, qty_accepted, returned_qty, unit_price_sen, discount_sen, line_total_sen, delivery_date, variants';

/* WHICH purchase invoices count as having billed a receipt line: the SAME rule
   the stored counter is recounted by (recomputeGrnInvoiced in
   routes/purchase-invoices.ts) — a DRAFT consumes nothing until it is confirmed,
   a CANCELLED one gave its quantity back. Owner 2026-09-15: the export prints
   this live sum, not the stored grn_items.invoiced_qty. */
export const GRN_INVOICED_EXCLUDED_PI_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'CANCELLED']);

type HeaderRow = GrnExportHeader & { id: string; warehouse_id: string | null };
type LineRow = GrnExportLine & {
  grn_id: string;
  created_at: string | null;
  purchase_order_item_id: string | null;
  variants?: unknown;
};

type QueryError = { message: string } | null;
type Rows<T> = PromiseLike<{ data: T[] | null; error: QueryError }>;

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
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: QueryError }>;
};
type Sb = { from(table: string): Q };

/* The receipt detail page's line order: creation order, then the category rank
   (mains first), then each sofa build's modules left to right — the same three
   steps GET /grns/:id applies. */
function inDetailOrder(lines: LineRow[]): LineRow[] {
  const byCreation = [...lines].sort((a, b) => {
    const ac = a.created_at ?? '';
    const bc = b.created_at ?? '';
    if (ac !== bc) return ac < bc ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  /* The display helpers read only item_code, item_group and variants; the rows
     pass through them unchanged. */
  const ranked = sortSoLinesByGroupRank(byCreation, (l) => l.item_group);
  return orderSofaModuleRowsWithinBuilds(ranked as unknown as RawSoDisplayLine[]) as unknown as LineRow[];
}

export type GrnLineExport =
  | { error: string }
  | {
      error: null;
      columns: readonly string[];
      rows: GrnLineExportCell[][];
      grnCount: number;
      lineCount: number;
      truncated: boolean;
    };

export async function buildGrnLineExport(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: GrnListFilters,
): Promise<GrnLineExport> {
  const sb = sbIn as Sb;
  const read = await readDocumentsWithLines<HeaderRow, LineRow>({
    headers: (from, to) =>
      orderGrnList(filterGrnList(sb.from('grns').select(GRN_EXPORT_HEADER_COLS), filters, c), filters.sort).range(from, to),
    /* The company predicate on the LINE read too: a parent id is not company
       scope (CLAUDE.md R105 b). */
    lines: (batch, from, to) =>
      scopeToCompany(sb.from('grn_items').select(GRN_EXPORT_LINE_COLS), c)
        .in('grn_id', batch)
        .order('grn_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as Rows<LineRow>,
    parentOf: (l) => l.grn_id,
  });
  if (read.error !== null) return { error: read.error };

  const allLines = [...read.linesByHeader.values()].flat();

  /* PO line -> its PO number and the SO line it was raised for. Every lookup is
     company-scoped: a link pointing into another company prints blank, never
     that company's number. */
  const poLines = await lookupByIds<{ id: string; purchase_order_id: string | null; so_item_id: string | null }>(
    allLines.map((l) => l.purchase_order_item_id),
    (batch, from, to) =>
      scopeToCompany(sb.from('purchase_order_items').select('id, purchase_order_id, so_item_id'), c)
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; purchase_order_id: string | null; so_item_id: string | null }>,
  );
  if (poLines.error) return { error: `purchase order lines: ${poLines.error}` };

  const pos = await lookupByIds<{ id: string; po_number: string | null }>(
    [...poLines.byId.values()].map((l) => l.purchase_order_id),
    (batch, from, to) =>
      scopeToCompany(sb.from('purchase_orders').select('id, po_number'), c)
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; po_number: string | null }>,
  );
  if (pos.error) return { error: `purchase orders: ${pos.error}` };

  const so = await lookupByIds<{ id: string; doc_no: string | null }>(
    [...poLines.byId.values()].map((l) => l.so_item_id),
    (batch, from, to) =>
      scopeToCompany(sb.from('mfg_sales_order_items').select('id, doc_no'), c)
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; doc_no: string | null }>,
  );
  if (so.error) return { error: `sales order numbers: ${so.error}` };

  /* The ERP's own invoiced quantity: Σ purchase invoice line qty per receipt
     line, over the invoices GRN_INVOICED_EXCLUDED_PI_STATUSES does not exclude. */
  type PiLine = { id: string; purchase_invoice_id: string | null; grn_item_id: string | null; qty: number | string | null };
  const piLines = await chunkIn<PiLine>(allLines.map((l) => l.id), (batch, from, to) =>
    scopeToCompany(sb.from('purchase_invoice_items').select('id, purchase_invoice_id, grn_item_id, qty'), c)
      .in('grn_item_id', batch).order('id', { ascending: true }).range(from, to) as Rows<PiLine>);
  if (piLines.error) return { error: `purchase invoice lines: ${piLines.error.message}` };

  const pis = await lookupByIds<{ id: string; invoice_number: string | null; status: string | null }>(
    piLines.data.map((l) => l.purchase_invoice_id),
    (batch, from, to) =>
      scopeToCompany(sb.from('purchase_invoices').select('id, invoice_number, status'), c)
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; invoice_number: string | null; status: string | null }>,
  );
  if (pis.error) return { error: `purchase invoices: ${pis.error}` };

  const billed = new Map<string, { qty: number; numbers: string[] }>();
  for (const pl of piLines.data) {
    if (!pl.grn_item_id || !pl.purchase_invoice_id) continue;
    const pi = pis.byId.get(pl.purchase_invoice_id);
    /* An invoice the company-scoped read did not return is another company's:
       it is not counted, the same as one that does not exist. */
    if (!pi || GRN_INVOICED_EXCLUDED_PI_STATUSES.has(String(pi.status ?? '').toUpperCase())) continue;
    const acc = billed.get(pl.grn_item_id) ?? { qty: 0, numbers: [] };
    const q = Number(pl.qty ?? 0);
    acc.qty += Number.isFinite(q) ? q : 0;
    const no = (pi.invoice_number ?? '').trim();
    if (no && !acc.numbers.includes(no)) acc.numbers.push(no);
    billed.set(pl.grn_item_id, acc);
  }

  /* The receipt's warehouse, printed as AutoCount's SHORT code (`KL`, not
     `KL WAREHOUSE`; owner 2026-09-15) through the write-back's own
     LOCATION_MAP — the rule readConvertHeaderFacts sends a GR's Location by.
     Read by the ids of headers already read under the company scope. */
  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(
    read.headers.map((h) => h.warehouse_id),
    (batch, from, to) =>
      sb.from('warehouses').select('id, code, name')
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; code: string | null; name: string | null }>,
  );
  if (wh.error) return { error: `warehouses: ${wh.error}` };

  const rows: GrnLineExportCell[][] = [];
  for (const header of read.headers) {
    const location = bookSpellingOrOwn(warehouseLabel(header.warehouse_id ? wh.byId.get(header.warehouse_id) : null), LOCATION_MAP);
    for (const line of inDetailOrder(read.linesByHeader.get(header.id) ?? [])) {
      const poLine = line.purchase_order_item_id ? poLines.byId.get(line.purchase_order_item_id) : undefined;
      const bill = billed.get(line.id);
      rows.push(grnLineExportCells(header, line, {
        location,
        poNo: poLine?.purchase_order_id ? pos.byId.get(poLine.purchase_order_id)?.po_number ?? null : null,
        soDocNo: poLine?.so_item_id ? so.byId.get(poLine.so_item_id)?.doc_no ?? null : null,
        invoicedQty: bill?.qty ?? 0,
        invoiceNos: bill && bill.numbers.length > 0 ? bill.numbers.join(', ') : null,
      }));
    }
  }

  return {
    error: null,
    columns: GRN_LINE_EXPORT_COLUMNS,
    rows,
    grnCount: read.headers.length,
    lineCount: rows.length,
    truncated: read.truncated,
  };
}
