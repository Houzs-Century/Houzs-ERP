// ----------------------------------------------------------------------------
// delivery-return-list-read — what the Delivery Returns LIST matches, the list
// row's derived fields, and the lines each row carries, in one place.
//
// The list (GET /delivery-returns) and its export (GET /delivery-returns/export/rows)
// must read the SAME returns for the same caller and query: the same company,
// the same SALES SCOPE (own + downline unless view-all), the same status. Both
// build their header read through filterDeliveryReturnList +
// orderDeliveryReturnList, stamp the SO number and strip finance keys through
// the functions here, and attach lines through attachDeliveryReturnLines. The
// list still stops at its screen cap; the export pages to exhaustion.
//
// The tab and the search box filter in the BROWSER over this read (the list has
// always done so); the export applies the same predicate to its rows.
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { lookupByIds } from './document-line-export';
import { chunkIn } from './paginate-all';
import { pageWithTruncation } from './outstanding-po-lines';
import { warehouseLabel } from './warehouse-label';
import { bookSpellingOrOwn, resolveAcAgent } from '../../services/autocount-writeback';
import { BRANDING_MAP, LOCATION_MAP, VENUE_MAP } from '../../services/autocount-master-maps';
import { toDrListLine, type DrListLine } from './return-line-export-columns';
import { companyHasAutoCountBook, readReturnBookContext, returnLineBookFacts } from './return-line-book-facts';

/* FINANCE-GATED header keys — cost / margin / per-category revenue+cost
   subtotals. All are in DR_HEADER_COLS (so they travel in the DR list payload)
   but must reach ONLY a finance-viewer (lib/houzs-perms.canViewScmFinance).
   Stripped from every row for a non-finance caller. The DR header carries FOUR
   categories (no service_sen, unlike SO/DO/SI). Refund/total shown to everyone
   (local_total_sen / refund_sen) are NOT listed here.

   KEPT LOCAL to the delivery return, deliberately — do NOT "converge" it onto
   SO_FINANCE_KEYS. It is the finance-shaped subset of DR_HEADER_COLS, and the
   delivery return speaks a narrower money vocabulary than the SO: no
   service_sen / service_cost_sen and no deposit_sen (a return takes no
   deposit). refund_sen is in the header and deliberately NOT here — the refund
   is what the customer is owed and everyone who passes the access gate may see
   it, the same line #625 drew and #632 kept. The per-LINE keys ARE shared: they
   are byte-identical across all seven sales documents, so they live in
   lib/finance-keys (SO_ITEM_FINANCE_KEYS). */
/* A per-document subset (see above): the four DR categories and their costs,
   no service_* and no deposit_*, which SO_FINANCE_KEYS carries. */
/* eslint-disable no-restricted-syntax -- the delivery return's own header columns, a subset of the shared SO list */
export const DR_FINANCE_KEYS = [
  'mattress_sofa_sen', 'bedframe_sen', 'accessories_sen', 'others_sen',
  'mattress_sofa_cost_sen', 'bedframe_cost_sen', 'accessories_cost_sen', 'others_cost_sen',
  'total_cost_sen', 'total_margin_sen', 'margin_pct_basis',
] as const;
/* eslint-enable no-restricted-syntax */

/* Full DR header — mirrors the editable DO header shape. The pre-rebuild
   columns (delivery_order_id / sales_invoice_id / reason / received-inspected-
   refunded timestamps / inspection_notes) stay; the DO-clone fields added in
   migration 0102 (debtor metadata / salesperson / address / per-category
   totals + costs / branding / venue / ref / warehouse) extend it. */
export const DR_HEADER_COLS =
  'id, return_number, do_doc_no, delivery_order_id, sales_invoice_id, ' +
  'debtor_code, debtor_name, return_date, reason, status, ' +
  'received_at, inspected_at, refunded_at, refund_sen, inspection_notes, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, sales_location, customer_state, customer_country, note, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, ' +
  'mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, ' +
  'local_total_sen, total_cost_sen, total_margin_sen, margin_pct_basis, line_count, ' +
  'currency, warehouse_id, notes, created_at, created_by, updated_at';

/* No cost / margin columns: the line read never carries them, so no gate is
   needed on what it returns. */
export const DR_LINE_READ_COLS =
  'id, delivery_return_id, do_item_id, created_at, item_code, item_group, description, description2, ' +
  'uom, qty_returned, condition, unit_price_sen, discount_sen, line_total_sen, notes, variants';

export type DeliveryReturnListFilters = { status: string | null };

export function readDeliveryReturnListFilters(query: (key: string) => string | undefined): DeliveryReturnListFilters {
  const s = query('status');
  return { status: s === undefined || s === '' ? null : s };
}

type Filterable = {
  order(col: string, opts: { ascending: boolean }): Filterable;
  eq(col: string, val: unknown): Filterable;
  in(col: string, vals: string[]): Filterable;
};

/** Newest return first; return_number is the unique tiebreaker so range paging
 *  can neither skip nor repeat returns dated the same day. */
export function orderDeliveryReturnList<Q>(q: Q): Q {
  return (q as unknown as Filterable)
    .order('return_date', { ascending: false })
    .order('return_number', { ascending: false }) as unknown as Q;
}

/** Sales scope + status + COMPANY. `scopeIds` is resolveSalesScopeIds' answer:
 *  null = view-all, otherwise the salesperson ids the caller may see (a NULL
 *  salesperson_id row is not visible to a scoped caller — lib/salesScope.ts). */
export function filterDeliveryReturnList<Q>(
  q: Q,
  f: DeliveryReturnListFilters,
  c: CompanyScopeCtx,
  scopeIds: string[] | null,
): Q {
  let out = q as unknown as Filterable;
  if (scopeIds) out = out.in('salesperson_id', scopeIds);
  if (f.status) out = out.eq('status', f.status);
  return scopeToCompany(out, c) as unknown as Q;
}

/** Strip the finance header keys in place for a non-finance caller. */
export function gateDrListFinance(rows: unknown[], canViewFinance: boolean): void {
  if (canViewFinance) return;
  for (const r of rows) {
    if (r && typeof r === 'object') {
      for (const k of DR_FINANCE_KEYS) delete (r as Record<string, unknown>)[k];
    }
  }
}

type QueryError = { message: string } | null;
type Page<T> = PromiseLike<{ data: T[] | null; error: QueryError }>;
type Q = {
  select(cols: string): Q;
  order(col: string, opts: { ascending: boolean }): Q;
  in(col: string, vals: string[]): Q;
  eq(col: string, val: unknown): Q;
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: QueryError }>;
};
type Sb = { from(table: string): Q };

/* Convert-from column (display-only, audit R8): the DR list already shows its
   source DO (do_doc_no); resolve the Sales Order behind that DO so the list can
   also show "From SO", matching the SO/DO/SI lists. Keyed by delivery_order_id
   -> delivery_orders.so_doc_no, company-scoped. Stamps `so_doc_no` in place and
   returns the read error: the list shows the rows anyway (the SO number is
   ancillary), the export refuses. */
export async function stampDrListSoDocNo(
  sbIn: unknown,
  c: CompanyScopeCtx,
  rows: Array<Record<string, unknown>>,
): Promise<{ error: string | null }> {
  const sb = sbIn as Sb;
  type DoRow = { id: string; so_doc_no: string | null };
  const dos = await lookupByIds<DoRow>(rows.map((r) => r.delivery_order_id as string | null), (batch, from, to) =>
    scopeToCompany(sb.from('delivery_orders').select('id, so_doc_no'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Page<DoRow>);
  for (const r of rows) {
    r.so_doc_no = dos.byId.get((r.delivery_order_id as string | null) ?? '')?.so_doc_no ?? null;
  }
  return { error: dos.error ? `delivery orders: ${dos.error}` : null };
}

/* The book's spellings, stamped on each row for the grid and the file:
   `ac_agent` — AutoCount's "Agent", by the write-back's own rule (resolveAcAgent:
   the typed agent through AGENT_MAP, else the salesperson's name through it,
   else the name); `ac_branding` / `ac_venue` — through BRANDING_MAP / VENUE_MAP
   as the write-back sends them. For the company whose book it is only; elsewhere
   the salesperson's name (else the typed agent) and the ERP's own words. Staff
   names are read by the ids of rows already read under the company scope. */
export async function stampDrListBookSpellings(
  sbIn: unknown,
  c: CompanyScopeCtx,
  rows: Array<Record<string, unknown>>,
): Promise<{ error: string | null }> {
  const sb = sbIn as Sb;
  type Staff = { id: string; name: string | null };
  const staff = await lookupByIds<Staff>(rows.map((r) => r.salesperson_id as string | null), (batch, from, to) =>
    sb.from('staff').select('id, name').in('id', batch).order('id', { ascending: true }).range(from, to) as Page<Staff>);
  const inBook = companyHasAutoCountBook(c);
  for (const r of rows) {
    const name = (staff.byId.get((r.salesperson_id as string | null) ?? '')?.name ?? '').trim() || null;
    const typed = typeof r.agent === 'string' ? r.agent : null;
    r.ac_agent = inBook ? resolveAcAgent(typed, name) : (name ?? ((typed ?? '').trim() || null));
    const branding = typeof r.branding === 'string' ? r.branding : null;
    const venue = typeof r.venue === 'string' ? r.venue : null;
    r.ac_branding = inBook ? bookSpellingOrOwn(branding, BRANDING_MAP) : ((branding ?? '').trim() || null);
    r.ac_venue = inBook ? bookSpellingOrOwn(venue, VENUE_MAP) : ((venue ?? '').trim() || null);
  }
  return { error: staff.error ? `staff: ${staff.error}` : null };
}

type LineRow = Parameters<typeof toDrListLine>[0] & {
  delivery_return_id: string;
  do_item_id: string | null;
  created_at: string | null;
  variants?: unknown;
};

export type DrLineHeader = { id: string; warehouse_id?: string | null };

const byCreation = (a: LineRow, b: LineRow): number => {
  const ac = a.created_at ?? '';
  const bc = b.created_at ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Attach `lines` (DrListLine[], in creation order) to each return. The headers
 * must already have been read under the company scope and the sales scope; the
 * line read and every lookup carry the company predicate themselves (a parent
 * id is not company scope, CLAUDE.md R105 b).
 *
 * Location is the warehouse the line went BACK into, by the stock rule
 * (routes/delivery-returns.ts resolveDrLineWarehouses): the delivered SO line's
 * warehouse, else the delivery order's, else the return's own — printed as
 * AutoCount's SHORT code through the write-back's LOCATION_MAP (owner
 * 2026-09-15). The company-default last resort the stock write uses is not
 * guessed here; such a line prints blank.
 */
export async function attachDeliveryReturnLines<H extends DrLineHeader>(
  sbIn: unknown,
  c: CompanyScopeCtx,
  headers: H[],
): Promise<{ error: string | null; rows: Array<H & { lines: DrListLine[] }>; lineCount: number }> {
  const sb = sbIn as Sb;
  const fail = (error: string) => ({ error, rows: [], lineCount: 0 });
  const ids = [...new Set(headers.map((h) => h.id))];
  const lineRead = await chunkIn<LineRow>(ids, (batch, from, to) =>
    scopeToCompany(sb.from('delivery_return_items').select(DR_LINE_READ_COLS), c)
      .in('delivery_return_id', batch)
      .order('delivery_return_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to) as Page<LineRow>);
  if (lineRead.error) return fail(`lines: ${lineRead.error.message}`);
  const all = lineRead.data;

  type DoLine = { id: string; so_item_id: string | null; delivery_order_id: string | null };
  const doLines = await lookupByIds<DoLine>(all.map((l) => l.do_item_id), (batch, from, to) =>
    scopeToCompany(sb.from('delivery_order_items').select('id, so_item_id, delivery_order_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Page<DoLine>);
  if (doLines.error) return fail(`delivery order lines: ${doLines.error}`);

  type DoHead = { id: string; warehouse_id: string | null };
  const doHeads = await lookupByIds<DoHead>([...doLines.byId.values()].map((d) => d.delivery_order_id), (batch, from, to) =>
    scopeToCompany(sb.from('delivery_orders').select('id, warehouse_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Page<DoHead>);
  if (doHeads.error) return fail(`delivery orders: ${doHeads.error}`);

  type SoLine = { id: string; doc_no: string | null; warehouse_id: string | null };
  const soLines = await lookupByIds<SoLine>([...doLines.byId.values()].map((d) => d.so_item_id), (batch, from, to) =>
    scopeToCompany(sb.from('mfg_sales_order_items').select('id, doc_no, warehouse_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Page<SoLine>);
  if (soLines.error) return fail(`sales order lines: ${soLines.error}`);

  type Wh = { id: string; code: string | null; name: string | null };
  const wh = await lookupByIds<Wh>(
    [
      ...[...soLines.byId.values()].map((s) => s.warehouse_id),
      ...[...doHeads.byId.values()].map((d) => d.warehouse_id),
      ...headers.map((h) => h.warehouse_id ?? null),
    ],
    (batch, from, to) =>
      sb.from('warehouses').select('id, code, name').in('id', batch).order('id', { ascending: true }).range(from, to) as Page<Wh>,
  );
  if (wh.error) return fail(`warehouses: ${wh.error}`);

  const book = await readReturnBookContext(sb, c, all.map((l) => ({ code: l.item_code, supplierId: null })));
  if (book.error) return fail(book.error);

  const byReturn = new Map<string, LineRow[]>();
  for (const l of all) {
    const arr = byReturn.get(l.delivery_return_id) ?? [];
    arr.push(l);
    byReturn.set(l.delivery_return_id, arr);
  }
  const rows = headers.map((h) => {
    const lines = [...(byReturn.get(h.id) ?? [])].sort(byCreation).map((l) => {
      const dl = l.do_item_id ? doLines.byId.get(l.do_item_id) : undefined;
      const so = dl?.so_item_id ? soLines.byId.get(dl.so_item_id) : undefined;
      const doWh = dl?.delivery_order_id ? doHeads.byId.get(dl.delivery_order_id)?.warehouse_id ?? null : null;
      const lineWh = so?.warehouse_id ?? doWh ?? h.warehouse_id ?? null;
      return toDrListLine(l, {
        ...returnLineBookFacts(book.ctx, l, { id: null, code: null }),
        location: bookSpellingOrOwn(warehouseLabel(lineWh ? wh.byId.get(lineWh) : null), LOCATION_MAP),
        soDocNo: so?.doc_no ?? null,
      });
    });
    return { ...h, lines };
  });
  return { error: null, rows, lineCount: all.length };
}

export type DeliveryReturnExportRows =
  | { error: string }
  | { error: null; deliveryReturns: Array<DrLineHeader & Record<string, unknown> & { lines: DrListLine[] }>; total: number; lineCount: number; truncated: boolean };

/** Every return the list's filter and the caller's sales scope match (no screen
 *  cap, paged to exhaustion) in the list's row shape — SO number and book
 *  spellings stamped, finance keys stripped for a non-finance caller — each with
 *  its lines. GET /delivery-returns/export/rows. */
export async function buildDeliveryReturnExportRows(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: DeliveryReturnListFilters,
  scopeIds: string[] | null,
  canViewFinance: boolean,
): Promise<DeliveryReturnExportRows> {
  const sb = sbIn as Sb;
  const read = await pageWithTruncation<DrLineHeader & Record<string, unknown>>((from, to) =>
    orderDeliveryReturnList(filterDeliveryReturnList(sb.from('delivery_returns').select(DR_HEADER_COLS), filters, c, scopeIds))
      .range(from, to));
  if (read.error) return { error: `headers: ${read.error.message}` };
  const headers = read.data ?? [];
  const stamped = await stampDrListSoDocNo(sb, c, headers);
  if (stamped.error) return { error: stamped.error };
  const spelled = await stampDrListBookSpellings(sb, c, headers);
  if (spelled.error) return { error: spelled.error };
  gateDrListFinance(headers, canViewFinance);
  const attached = await attachDeliveryReturnLines(sb, c, headers);
  if (attached.error !== null) return { error: attached.error };
  return { error: null, deliveryReturns: attached.rows, total: attached.rows.length, lineCount: attached.lineCount, truncated: read.truncated };
}
