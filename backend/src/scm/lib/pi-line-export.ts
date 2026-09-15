// ----------------------------------------------------------------------------
// pi-line-export — the Purchase Invoice plug-in for document-line-export.
//
// Every line of every invoice the Purchase Invoices list's CURRENT tab, search
// and sort match, across all pages, shaped as the columns in
// pi-line-export-columns.ts. Read by GET /purchase-invoices/export/lines
// (routes/purchase-invoice-exports.ts).
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { readDocumentsWithLines, lookupByIds } from './document-line-export';
import { filterPiList, orderPiList, type PiListFilters } from './pi-list-read';
import { warehouseLabel } from './warehouse-label';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { orderSofaModuleRowsWithinBuilds, sortSoLinesByGroupRank, type RawSoDisplayLine } from '../shared/so-line-display';
import {
  PI_LINE_EXPORT_COLUMNS,
  piLineExportCells,
  type PiExportHeader,
  type PiExportLine,
  type PiLineExportCell,
} from './pi-line-export-columns';

export const PI_EXPORT_HEADER_COLS =
  'id, invoice_number, linked_ac_docno, invoice_date, status, on_hold, supplier_invoice_ref, currency, due_date, ' +
  'total_sen, paid_sen, supplier:suppliers(code, name)';

export const PI_EXPORT_LINE_COLS =
  'id, purchase_invoice_id, created_at, grn_item_id, item_code, material_name, description, description2, notes, ' +
  'item_group, uom, qty, po_unit_price_sen, unit_price_sen, discount_sen, line_total_sen, variants';

type HeaderRow = PiExportHeader & { id: string };
type LineRow = PiExportLine & {
  purchase_invoice_id: string;
  created_at: string | null;
  grn_item_id: string | null;
  variants?: unknown;
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

/* The invoice detail page's line order: creation order, then the category rank
   (mains first), then each sofa build's modules left to right — the same three
   steps GET /purchase-invoices/:id applies. */
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

export type PiLineExport =
  | { error: string }
  | {
      error: null;
      columns: readonly string[];
      rows: PiLineExportCell[][];
      piCount: number;
      lineCount: number;
      truncated: boolean;
    };

export async function buildPiLineExport(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: PiListFilters,
  today: string,
): Promise<PiLineExport> {
  const sb = sbIn as Sb;
  const read = await readDocumentsWithLines<HeaderRow, LineRow>({
    headers: (from, to) =>
      orderPiList(filterPiList(sb.from('purchase_invoices').select(PI_EXPORT_HEADER_COLS), filters, c), filters.sort).range(from, to),
    /* The company predicate on the LINE read too: a parent id is not company
       scope (CLAUDE.md R105 b). */
    lines: (batch, from, to) =>
      scopeToCompany(sb.from('purchase_invoice_items').select(PI_EXPORT_LINE_COLS), c)
        .in('purchase_invoice_id', batch)
        .order('purchase_invoice_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as Rows<LineRow>,
    parentOf: (l) => l.purchase_invoice_id,
  });
  if (read.error !== null) return { error: read.error };

  const allLines = [...read.linesByHeader.values()].flat();

  /* The invoice line carries no SKU, warehouse or PO of its own: all three come
     through the GRN line it bills. Every hop is company-scoped, so a link into
     another company prints blank, never that company's value. */
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

  const pos = await lookupByIds<{ id: string; po_number: string | null }>(
    [...poLines.byId.values()].map((l) => l.purchase_order_id), (batch, from, to) =>
      scopeToCompany(sb.from('purchase_orders').select('id, po_number'), c)
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; po_number: string | null }>);
  if (pos.error) return { error: `purchase orders: ${pos.error}` };

  const so = await lookupByIds<{ id: string; doc_no: string | null }>(
    [...poLines.byId.values()].map((l) => l.so_item_id), (batch, from, to) =>
      scopeToCompany(sb.from('mfg_sales_order_items').select('id, doc_no'), c)
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; doc_no: string | null }>);
  if (so.error) return { error: `sales order numbers: ${so.error}` };

  /* The GRN's warehouse as AutoCount's SHORT code (`KL`; owner 2026-09-15),
     through the write-back's own LOCATION_MAP. Read by the ids of receipts
     already read under the company scope. */
  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(
    [...grns.byId.values()].map((g) => g.warehouse_id), (batch, from, to) =>
      sb.from('warehouses').select('id, code, name')
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; code: string | null; name: string | null }>);
  if (wh.error) return { error: `warehouses: ${wh.error}` };

  const rows: PiLineExportCell[][] = [];
  for (const header of read.headers) {
    for (const line of inDetailOrder(read.linesByHeader.get(header.id) ?? [])) {
      const g = line.grn_item_id ? grnLines.byId.get(line.grn_item_id) : undefined;
      const receipt = g?.grn_id ? grns.byId.get(g.grn_id) : undefined;
      const poLine = g?.purchase_order_item_id ? poLines.byId.get(g.purchase_order_item_id) : undefined;
      rows.push(piLineExportCells(header, line, {
        supplierSku: g?.supplier_sku ?? null,
        location: bookSpellingOrOwn(warehouseLabel(receipt?.warehouse_id ? wh.byId.get(receipt.warehouse_id) : null), LOCATION_MAP),
        grnNo: receipt?.grn_number ?? null,
        poNo: poLine?.purchase_order_id ? pos.byId.get(poLine.purchase_order_id)?.po_number ?? null : null,
        soDocNo: poLine?.so_item_id ? so.byId.get(poLine.so_item_id)?.doc_no ?? null : null,
        today,
      }));
    }
  }

  return {
    error: null,
    columns: PI_LINE_EXPORT_COLUMNS,
    rows,
    piCount: read.headers.length,
    lineCount: rows.length,
    truncated: read.truncated,
  };
}
