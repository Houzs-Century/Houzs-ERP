// ----------------------------------------------------------------------------
// si-line-export — the Sales Invoice plug-in for document-line-export.
//
// Every line of every invoice the Sales Invoices list's CURRENT tab, search,
// sort AND sales scope match, across all pages, shaped as the columns in
// si-line-export-columns.ts. Read by GET /sales-invoices/export/lines
// (routes/sales-invoice-exports.ts).
// ----------------------------------------------------------------------------

import { activeCompanyId, scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { readDocumentsWithLines, lookupByIds } from './document-line-export';
import { filterSiList, orderSiList, type SiListFilters } from './si-list-read';
import { stampOrderDeposit } from './si-order-deposit';
import { warehouseLabel } from './warehouse-label';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import {
  SI_LINE_EXPORT_COLUMNS,
  siLineExportCells,
  type SiExportHeader,
  type SiExportLine,
  type SiLineExportCell,
} from './si-line-export-columns';

export const SI_EXPORT_HEADER_COLS =
  'id, invoice_number, linked_ac_docno, invoice_date, status, debtor_code, debtor_name, ref, customer_so_no, po_doc_no, ' +
  'due_date, total_sen, local_total_sen, paid_sen, salesperson_id, agent, branding, venue, phone, so_doc_no, sales_location';

export const SI_EXPORT_LINE_COLS =
  'id, sales_invoice_id, line_no, created_at, do_item_id, item_code, description, description2, notes, item_group, uom, ' +
  'qty, unit_price_sen, discount_sen, line_total_sen, line_delivery_date';

type HeaderRow = SiExportHeader & { id: string; salesperson_id: string | null; sales_location: string | null };
type LineRow = SiExportLine & {
  sales_invoice_id: string;
  line_no: number | null;
  created_at: string | null;
  do_item_id: string | null;
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

/* The invoice detail page's line order: line_no (blank last), then creation
   order — what GET /sales-invoices/:id asks the database for — then id. */
const byLinePosition = (a: LineRow, b: LineRow): number => {
  const an = a.line_no ?? Infinity;
  const bn = b.line_no ?? Infinity;
  if (an !== bn) return an < bn ? -1 : 1;
  const ac = a.created_at ?? '';
  const bc = b.created_at ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/* The order deposit is split across an order's sibling invoices, so it is
   stamped through the list's own function (stampOrderDeposit) — never
   recomputed here. That function reads its orders with one `in` list, so it is
   fed invoices a URL-sized batch at a time; its allocation is over each order's
   WHOLE sibling set regardless of the batch. */
const DEPOSIT_BATCH = 80;

export type SiLineExport =
  | { error: string }
  | {
      error: null;
      columns: readonly string[];
      rows: SiLineExportCell[][];
      siCount: number;
      lineCount: number;
      truncated: boolean;
    };

export async function buildSiLineExport(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: SiListFilters,
  scopeIds: string[] | null,
  today: string,
): Promise<SiLineExport> {
  const sb = sbIn as Sb;
  const read = await readDocumentsWithLines<HeaderRow, LineRow>({
    headers: (from, to) =>
      orderSiList(filterSiList(sb.from('sales_invoices').select(SI_EXPORT_HEADER_COLS), filters, c, scopeIds), filters.sort).range(from, to),
    /* The company predicate on the LINE read too: a parent id is not company
       scope (CLAUDE.md R105 b). */
    lines: (batch, from, to) =>
      scopeToCompany(sb.from('sales_invoice_items').select(SI_EXPORT_LINE_COLS), c)
        .in('sales_invoice_id', batch)
        .order('sales_invoice_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as Rows<LineRow>,
    parentOf: (l) => l.sales_invoice_id,
  });
  if (read.error !== null) return { error: read.error };

  const allLines = [...read.linesByHeader.values()].flat();

  /* The DO line -> its delivery order. The invoice line's so_item_id is empty
     on every production line (docs/line-export-columns.md §3), so the delivery
     order — and its warehouse — are reached through do_item_id. Both hops are
     company-scoped. */
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

  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(
    [...dos.byId.values()].map((d) => d.warehouse_id), (batch, from, to) =>
      sb.from('warehouses').select('id, code, name')
        .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; code: string | null; name: string | null }>);
  if (wh.error) return { error: `warehouses: ${wh.error}` };

  /* Salesperson names, by the ids of invoices already read under the company
     and sales scope — the same staff read the Sales Invoice Detail Listing
     makes (routes/reports.ts resolveStaffNames). */
  const staff = await lookupByIds<{ id: string; name: string | null }>(read.headers.map((h) => h.salesperson_id), (batch, from, to) =>
    sb.from('staff').select('id, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Rows<{ id: string; name: string | null }>);
  if (staff.error) return { error: `salespeople: ${staff.error}` };

  const deposits = new Map<string, number>();
  const companyId = activeCompanyId(c) ?? null;
  for (let i = 0; i < read.headers.length; i += DEPOSIT_BATCH) {
    const stubs: Array<Record<string, unknown>> = read.headers
      .slice(i, i + DEPOSIT_BATCH)
      .map((h) => ({ id: h.id, so_doc_no: h.so_doc_no ?? null }));
    await stampOrderDeposit(sb, stubs, companyId);
    for (const st of stubs) {
      /* stampOrderDeposit leaves the field null when its read FAILED (it logs
         and moves on, which a screen can afford). A file cannot: an unknown
         deposit exported as 0 over-states what the customer owes with nothing
         in the sheet to say so. */
      if (st.so_deposit_applied_sen === null && companyId !== null) {
        return { error: 'order deposits: the deposit read failed, so Balance cannot be computed' };
      }
      deposits.set(String(st.id), Number(st.so_deposit_applied_sen ?? 0));
    }
  }

  const rows: SiLineExportCell[][] = [];
  for (const header of read.headers) {
    const lines = [...(read.linesByHeader.get(header.id) ?? [])].sort(byLinePosition);
    for (const line of lines) {
      const doLine = line.do_item_id ? doLines.byId.get(line.do_item_id) : undefined;
      const delivery = doLine?.delivery_order_id ? dos.byId.get(doLine.delivery_order_id) : undefined;
      /* Where the goods shipped from, as AutoCount's SHORT code (`KL`; owner
         2026-09-15) through the write-back's LOCATION_MAP: the delivery order's
         warehouse, else the location that delivery order was sold from, else
         the invoice's own sales location (an invoice with no delivery line). */
      const place = warehouseLabel(delivery?.warehouse_id ? wh.byId.get(delivery.warehouse_id) : null)
        ?? delivery?.sales_location
        ?? header.sales_location;
      rows.push(siLineExportCells(header, line, {
        location: bookSpellingOrOwn(place, LOCATION_MAP),
        doNo: delivery?.do_number ?? null,
        salespersonName: header.salesperson_id ? staff.byId.get(header.salesperson_id)?.name ?? null : null,
        depositAppliedSen: deposits.get(header.id) ?? 0,
        today,
      }));
    }
  }

  return {
    error: null,
    columns: SI_LINE_EXPORT_COLUMNS,
    rows,
    siCount: read.headers.length,
    lineCount: rows.length,
    truncated: read.truncated,
  };
}
