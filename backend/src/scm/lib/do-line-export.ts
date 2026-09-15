// ----------------------------------------------------------------------------
// do-line-export — the Delivery Order plug-in for document-line-export.
//
// Every line of every delivery order the DO list's CURRENT tab, search and sort
// match, across all pages, shaped as the columns in do-line-export-columns.ts —
// which carry no price or amount (owner 2026-09-15). Read by
// GET /delivery-orders-mfg/export/lines (routes/delivery-order-exports.ts).
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { readDocumentsWithLines, lookupByIds } from './document-line-export';
import { filterDoList, fromDoList, orderDoList, type DoListParams } from './do-list-read';
import { doLineRemaining } from './do-line-remaining';
import { warehouseLabel } from './warehouse-label';
import { chunkIn } from './paginate-all';
import { mytDateOf } from './my-time';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import {
  DO_LINE_EXPORT_COLUMNS,
  doLineExportCells,
  type DoExportHeader,
  type DoExportLine,
  type DoLineExportCell,
} from './do-line-export-columns';

export const DO_EXPORT_HEADER_COLS =
  'id, do_number, linked_ac_docno, do_date, status, on_hold, debtor_code, debtor_name, ref, customer_so_no, so_doc_no, ' +
  'customer_delivery_date, expected_delivery_at, delivered_at, branding, venue, driver_name, vehicle, phone, ' +
  'address1, address2, city, postcode, state, warehouse_id, sales_location, salesperson_id, agent';

/* No unit_price_sen / discount_sen / line_total_sen: the file carries no money,
   so the read does not fetch it either. */
export const DO_EXPORT_LINE_COLS =
  'id, delivery_order_id, line_no, created_at, item_code, description, description2, notes, item_group, uom, ' +
  'qty, m3_milli, line_delivery_date, so_item_id';

type HeaderRow = DoExportHeader & {
  id: string;
  delivered_at: string | null;
  warehouse_id: string | null;
  sales_location: string | null;
  salesperson_id: string | null;
  agent: string | null;
};
type LineRow = DoExportLine & {
  delivery_order_id: string;
  line_no: number | null;
  created_at: string | null;
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

const byLinePosition = (a: LineRow, b: LineRow): number => {
  const an = a.line_no ?? Infinity;
  const bn = b.line_no ?? Infinity;
  if (an !== bn) return an < bn ? -1 : 1;
  const ac = a.created_at ?? '';
  const bc = b.created_at ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export type DoLineExport =
  | { error: string }
  | {
      error: null;
      columns: readonly string[];
      rows: DoLineExportCell[][];
      doCount: number;
      lineCount: number;
      truncated: boolean;
    };

export async function buildDoLineExport(
  sbIn: unknown,
  c: CompanyScopeCtx,
  params: DoListParams,
  scopeIds: string[] | null,
): Promise<DoLineExport> {
  const sb = sbIn as Sb;
  const docs = await readDocumentsWithLines<HeaderRow, LineRow>({
    headers: (from, to) =>
      filterDoList(orderDoList(fromDoList(sb, DO_EXPORT_HEADER_COLS), params.sort), params, c, scopeIds)
        .range(from, to),
    /* The company predicate on the LINE read too: a parent id is not company
       scope (CLAUDE.md R105 b). */
    lines: (batch, from, to) =>
      scopeToCompany(sb.from('delivery_order_items').select(DO_EXPORT_LINE_COLS), c)
        .in('delivery_order_id', batch)
        .order('delivery_order_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as Res<LineRow>,
    parentOf: (l) => l.delivery_order_id,
  });
  if (docs.error !== null) return { error: docs.error };

  const allLines = [...docs.linesByHeader.values()].flat();

  /* Invoiced / Returned / Uninvoiced — the app's own Pending ledger, the one the
     DO→Sales Invoice and DO→Delivery Return pickers enforce. 'invoiceable' is
     the question this column asks. It fails closed. */
  const pending = await doLineRemaining(sb, docs.headers.map((h) => h.id), 'invoiceable');
  if (!pending.ok) return { error: `invoiced quantities: ${pending.reason}` };

  /* The invoice numbers each line was billed on (invoice not cancelled). */
  const siLines = await chunkIn<{ id: string; do_item_id: string | null; sales_invoice_id: string | null }>(
    allLines.map((l) => l.id),
    (batch, from, to) => scopeToCompany(sb.from('sales_invoice_items').select('id, do_item_id, sales_invoice_id'), c)
      .in('do_item_id', batch).order('id', { ascending: true }).range(from, to) as Res<never>,
  );
  if (siLines.error) return { error: `sales invoice lines: ${siLines.error.message}` };
  const sis = await lookupByIds<{ id: string; invoice_number: string | null; status: string | null }>(
    siLines.data.map((l) => l.sales_invoice_id),
    (batch, from, to) => scopeToCompany(sb.from('sales_invoices').select('id, invoice_number, status'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>,
  );
  if (sis.error) return { error: `sales invoices: ${sis.error}` };
  const invoiceNosByLine = new Map<string, Set<string>>();
  for (const l of siLines.data) {
    const si = l.sales_invoice_id ? sis.byId.get(l.sales_invoice_id) : undefined;
    if (!l.do_item_id || !si?.invoice_number || String(si.status ?? '').toUpperCase() === 'CANCELLED') continue;
    invoiceNosByLine.set(l.do_item_id, (invoiceNosByLine.get(l.do_item_id) ?? new Set()).add(si.invoice_number));
  }

  /* The Sales Order number each line was raised from. Company-scoped: a line
     pointing at another company's order must not print that company's number. */
  const so = await lookupByIds<{ id: string; doc_no: string | null }>(
    allLines.map((l) => l.so_item_id),
    (batch, from, to) => scopeToCompany(sb.from('mfg_sales_order_items').select('id, doc_no'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>,
  );
  if (so.error) return { error: `sales order numbers: ${so.error}` };

  /* The delivery warehouse lives on the DO header. Warehouses and staff are read
     by the ids of rows already read under the company scope. */
  const wh = await lookupByIds<{ id: string; code: string | null; name: string | null }>(
    docs.headers.map((h) => h.warehouse_id),
    (batch, from, to) => sb.from('warehouses').select('id, code, name')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>,
  );
  if (wh.error) return { error: `warehouses: ${wh.error}` };
  const staff = await lookupByIds<{ id: string; name: string | null; staff_code: string | null }>(
    docs.headers.map((h) => h.salesperson_id),
    (batch, from, to) => sb.from('staff').select('id, name, staff_code')
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Res<never>,
  );
  if (staff.error) return { error: `staff: ${staff.error}` };

  const rows: DoLineExportCell[][] = [];
  for (const header of docs.headers) {
    const lines = [...(docs.linesByHeader.get(header.id) ?? [])].sort(byLinePosition);
    const headerWh = header.warehouse_id ? wh.byId.get(header.warehouse_id) : null;
    /* AutoCount's SHORT code (`KL`, owner 2026-09-15) through the write-back's
       own LOCATION_MAP; a DO with no warehouse keeps its sales_location text. */
    const location = bookSpellingOrOwn(warehouseLabel(headerWh) ?? header.sales_location, LOCATION_MAP);
    const s = header.salesperson_id ? staff.byId.get(header.salesperson_id) : undefined;
    /* The list's Salesperson: the staff row the salesperson id names; the
       header's agent text only where no staff row resolves. */
    const salesperson = (s?.name || s?.staff_code || null) ?? header.agent;
    const deliveredOn = header.delivered_at ? mytDateOf(header.delivered_at) : null;
    for (const line of lines) {
      const p = pending.lines.get(line.id);
      rows.push(doLineExportCells(header, line, {
        location,
        salesperson,
        invoiced: p ? p.invoiced : null,
        returned: p ? p.returned : null,
        uninvoiced: p ? p.remaining : null,
        deliveredOn,
        soDocNo: line.so_item_id ? so.byId.get(line.so_item_id)?.doc_no ?? null : null,
        invoiceNos: [...(invoiceNosByLine.get(line.id) ?? [])].sort(),
      }));
    }
  }

  return {
    error: null,
    columns: DO_LINE_EXPORT_COLUMNS,
    rows,
    doCount: docs.headers.length,
    lineCount: rows.length,
    truncated: docs.truncated,
  };
}
