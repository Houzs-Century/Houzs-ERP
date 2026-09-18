// ----------------------------------------------------------------------------
// purchase-return-list-read — what the Purchase Returns LIST matches, and the
// lines each row carries, in one place.
//
// The list (GET /purchase-returns) and its export (GET /purchase-returns/export/rows)
// must read the SAME returns for the same query. Both build their header read
// through filterPurchaseReturnList + orderPurchaseReturnList and attach lines
// through attachPurchaseReturnLines, so a cell on screen and the same cell in
// the file cannot come from two reads. The list still stops at its screen cap;
// the export pages to exhaustion (owner 2026-09-15: the file holds every row
// the list's filters match).
//
// The tab and the search box filter in the BROWSER over this read (the list has
// always done so); the export applies the same predicate to its rows.
// ----------------------------------------------------------------------------

import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { lookupByIds } from './document-line-export';
import { chunkIn } from './paginate-all';
import { pageWithTruncation } from './outstanding-po-lines';
import { warehouseLabel } from './warehouse-label';
import { bookSpellingOrOwn } from '../../services/autocount-writeback';
import { LOCATION_MAP } from '../../services/autocount-master-maps';
import { toPrListLine, type PrListLine } from './return-line-export-columns';
import { readReturnBookContext, returnLineBookFacts } from './return-line-book-facts';

export const PR_HEADER_COLS =
  'id, return_number, purchase_order_id, grn_id, supplier_id, return_date, ' +
  'reason, status, posted_at, completed_at, credit_note_ref, refund_sen, ' +
  'notes, created_at, created_by, updated_at';

/* The GRN embed carries the receipt's currency and warehouse: a return has
   neither of its own, and AutoCount's Curr. Code / Location read them. */
export const PR_LIST_SELECT =
  `${PR_HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, address), ` +
  'purchase_order:purchase_orders(id, po_number), grn:grns(id, grn_number, currency, warehouse_id)';

export const PR_LINE_READ_COLS =
  'id, purchase_return_id, grn_item_id, created_at, item_code, material_name, description, description2, ' +
  'notes, reason, item_group, variants, uom, qty_returned, unit_price_sen, line_refund_sen';

/** The list's server-side filter contract, as the query string carries it. */
export type PurchaseReturnListFilters = { status: string | null; supplierId: string | null };

const param = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);

export function readPurchaseReturnListFilters(query: (key: string) => string | undefined): PurchaseReturnListFilters {
  return { status: param(query('status')), supplierId: param(query('supplierId')) };
}

type Filterable = {
  order(col: string, opts: { ascending: boolean }): Filterable;
  eq(col: string, val: unknown): Filterable;
};

/** Newest return first; return_number is the unique tiebreaker so range paging
 *  can neither skip nor repeat returns dated the same day. */
export function orderPurchaseReturnList<Q>(q: Q): Q {
  return (q as unknown as Filterable)
    .order('return_date', { ascending: false })
    .order('return_number', { ascending: false }) as unknown as Q;
}

/** Status + supplier + COMPANY. */
export function filterPurchaseReturnList<Q>(q: Q, f: PurchaseReturnListFilters, c: CompanyScopeCtx): Q {
  let out = q as unknown as Filterable;
  if (f.status) out = out.eq('status', f.status);
  if (f.supplierId) out = out.eq('supplier_id', f.supplierId);
  return scopeToCompany(out, c) as unknown as Q;
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

type LineRow = Parameters<typeof toPrListLine>[0] & {
  purchase_return_id: string;
  grn_item_id: string | null;
  created_at: string | null;
  variants?: unknown;
};

export type PrLineHeader = {
  id: string;
  supplier_id?: string | null;
  supplier?: { code?: string | null } | null;
  grn?: { grn_number?: string | null; warehouse_id?: string | null } | null;
  purchase_order?: { po_number?: string | null } | null;
};

/* The detail page's line order: creation, then id. */
const byCreation = (a: LineRow, b: LineRow): number => {
  const ac = a.created_at ?? '';
  const bc = b.created_at ?? '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Attach `lines` (PrListLine[], in detail-page order) to each return. The
 * headers must already have been read under the company scope; the line read
 * and every lookup carry the company predicate themselves (a parent id is not
 * company scope, CLAUDE.md R105 b). Returns the error rather than rows with
 * blank cells, so a failed lookup is never exported as "no GRN".
 */
export async function attachPurchaseReturnLines<H extends PrLineHeader>(
  sbIn: unknown,
  c: CompanyScopeCtx,
  headers: H[],
): Promise<{ error: string | null; rows: Array<H & { lines: PrListLine[] }>; lineCount: number }> {
  const sb = sbIn as Sb;
  const fail = (error: string) => ({ error, rows: [], lineCount: 0 });
  const ids = [...new Set(headers.map((h) => h.id))];
  const lineRead = await chunkIn<LineRow>(ids, (batch, from, to) =>
    scopeToCompany(sb.from('purchase_return_items').select(PR_LINE_READ_COLS), c)
      .in('purchase_return_id', batch)
      .order('purchase_return_id', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to) as Page<LineRow>);
  if (lineRead.error) return fail(`lines: ${lineRead.error.message}`);
  const all = lineRead.data;

  type GrnLine = { id: string; grn_id: string | null; purchase_order_item_id: string | null };
  const grnLines = await lookupByIds<GrnLine>(all.map((l) => l.grn_item_id), (batch, from, to) =>
    scopeToCompany(sb.from('grn_items').select('id, grn_id, purchase_order_item_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Page<GrnLine>);
  if (grnLines.error) return fail(`goods received lines: ${grnLines.error}`);

  type Grn = { id: string; grn_number: string | null; warehouse_id: string | null };
  const grns = await lookupByIds<Grn>([...grnLines.byId.values()].map((g) => g.grn_id), (batch, from, to) =>
    scopeToCompany(sb.from('grns').select('id, grn_number, warehouse_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Page<Grn>);
  if (grns.error) return fail(`goods received notes: ${grns.error}`);

  type PoLine = { id: string; purchase_order_id: string | null };
  const poLines = await lookupByIds<PoLine>([...grnLines.byId.values()].map((g) => g.purchase_order_item_id), (batch, from, to) =>
    scopeToCompany(sb.from('purchase_order_items').select('id, purchase_order_id'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Page<PoLine>);
  if (poLines.error) return fail(`purchase order lines: ${poLines.error}`);

  type Po = { id: string; po_number: string | null };
  const pos = await lookupByIds<Po>([...poLines.byId.values()].map((p) => p.purchase_order_id), (batch, from, to) =>
    scopeToCompany(sb.from('purchase_orders').select('id, po_number'), c)
      .in('id', batch).order('id', { ascending: true }).range(from, to) as Page<Po>);
  if (pos.error) return fail(`purchase orders: ${pos.error}`);

  /* Warehouses are read by the ids of receipts already read under the company
     scope, and printed as AutoCount's SHORT code (`KL`, owner 2026-09-15)
     through the write-back's own LOCATION_MAP. */
  type Wh = { id: string; code: string | null; name: string | null };
  const wh = await lookupByIds<Wh>(
    [...[...grns.byId.values()].map((g) => g.warehouse_id), ...headers.map((h) => h.grn?.warehouse_id ?? null)],
    (batch, from, to) =>
      sb.from('warehouses').select('id, code, name').in('id', batch).order('id', { ascending: true }).range(from, to) as Page<Wh>,
  );
  if (wh.error) return fail(`warehouses: ${wh.error}`);

  const supplierOf = new Map(headers.map((h) => [h.id, h.supplier_id ?? null]));
  const book = await readReturnBookContext(sb, c, all.map((l) => ({ code: l.item_code, supplierId: supplierOf.get(l.purchase_return_id) ?? null })));
  if (book.error) return fail(book.error);

  const byReturn = new Map<string, LineRow[]>();
  for (const l of all) {
    const arr = byReturn.get(l.purchase_return_id) ?? [];
    arr.push(l);
    byReturn.set(l.purchase_return_id, arr);
  }
  const rows = headers.map((h) => {
    const lines = [...(byReturn.get(h.id) ?? [])].sort(byCreation).map((l) => {
      const gl = l.grn_item_id ? grnLines.byId.get(l.grn_item_id) : undefined;
      const g = gl?.grn_id ? grns.byId.get(gl.grn_id) : undefined;
      const pl = gl?.purchase_order_item_id ? poLines.byId.get(gl.purchase_order_item_id) : undefined;
      const lineWh = g?.warehouse_id ?? h.grn?.warehouse_id ?? null;
      return toPrListLine(l, {
        ...returnLineBookFacts(book.ctx, { ...l, description: l.material_name ?? l.description }, { id: h.supplier_id ?? null, code: h.supplier?.code ?? null }),
        location: bookSpellingOrOwn(warehouseLabel(lineWh ? wh.byId.get(lineWh) : null), LOCATION_MAP),
        grnNo: g?.grn_number ?? h.grn?.grn_number ?? null,
        poNo: (pl?.purchase_order_id ? pos.byId.get(pl.purchase_order_id)?.po_number : null) ?? h.purchase_order?.po_number ?? null,
      });
    });
    return { ...h, lines };
  });
  return { error: null, rows, lineCount: all.length };
}

export type PurchaseReturnExportRows =
  | { error: string }
  | { error: null; purchaseReturns: Array<PrLineHeader & Record<string, unknown> & { lines: PrListLine[] }>; total: number; lineCount: number; truncated: boolean };

/** Every return the list's filter matches (no screen cap, paged to exhaustion)
 *  in the list's row shape, each with its lines. GET /purchase-returns/export/rows. */
export async function buildPurchaseReturnExportRows(
  sbIn: unknown,
  c: CompanyScopeCtx,
  filters: PurchaseReturnListFilters,
): Promise<PurchaseReturnExportRows> {
  const sb = sbIn as Sb;
  const read = await pageWithTruncation<PrLineHeader & Record<string, unknown>>((from, to) =>
    orderPurchaseReturnList(filterPurchaseReturnList(sb.from('purchase_returns').select(PR_LIST_SELECT), filters, c))
      .range(from, to));
  if (read.error) return { error: `headers: ${read.error.message}` };
  const attached = await attachPurchaseReturnLines(sb, c, read.data ?? []);
  if (attached.error !== null) return { error: attached.error };
  return { error: null, purchaseReturns: attached.rows, total: attached.rows.length, lineCount: attached.lineCount, truncated: read.truncated };
}
