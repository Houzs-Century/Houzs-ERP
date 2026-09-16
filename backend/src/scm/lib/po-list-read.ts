// ----------------------------------------------------------------------------
// po-list-read — what the Purchase Order LIST matches, in one place.
//
// The list (GET /mfg-purchase-orders?page=) and the two exports
// (GET /mfg-purchase-orders/export/headers, /export/lines) must match the SAME
// purchase orders for the same tab, search and sort. When the filter lived only
// inside the list handler, the only export there was could not reach it, and
// exported one screen page instead (docs/bugs — "the Purchase Order Export held
// one page"). Every reader now builds its query through these functions, so a
// new filter added here reaches all three at once.
//
// Lives here, not in routes/mfg-purchase-orders.ts, because that router is over
// its file-size ceiling.
// ----------------------------------------------------------------------------

import { PO_STATUS_BUCKETS } from './po-status-buckets';
import { HELD_OR_TERM, HOLD_COLUMNS } from './document-hold';
import { escapeForOr } from './postgrest-search';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { chunkIn } from './paginate-all';

export const PO_HEADER_COLS =
  'id, po_number, linked_ac_docno, supplier_id, status, po_date, expected_at, currency, ' +
  'subtotal_sen, tax_sen, total_sen, notes, submitted_at, received_at, ' +
  'cancelled_at, created_at, created_by, updated_at, ' +
  /* SO-amendment / revision workflow (2026-07-03) — bumped in place when a
     supplier-confirmed amendment revises this PO; prior versions snapshot to
     po_revisions. The PO Detail header shows a "Revised · rev N" badge when > 1. */
  'revision, ' +
  /* PR #77 — default ship-to warehouse for every line on this PO */
  'purchase_location_id, ' +
  /* Migration 0180 — supplier-revised delivery dates (header). The EFFECTIVE
     delivery date readers use = MAX over non-null of [expected_at, _2, _3, _4]
     (effectiveDelivery). expected_at keeps meaning the original earliest date. */
  'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, ' +
  /* Mig 0324 — the HOLD MARKER, rendered BESIDE the status pill. */
  HOLD_COLUMNS;

/* PR — Commander 2026-05-27: PO list rows surface a per-row items summary
   (AutoCount-style). purchase_location embeds the warehouse the PO ships to
   (PR #77), the list needs its NAME for the "Purchase Location" column (Owner
   2026-07-02). Supplier CONTACT fields ride the embed because the quick-view
   drawer renders its SUPPLIER panel straight off the list row (owner
   2026-07-24). supplier_sku rides the items embed (owner 2026-08-05). */
export const PO_LIST_SELECT = `${PO_HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, address), items:purchase_order_items(item_code, material_name, qty, supplier_sku), purchase_location:warehouses!purchase_location_id(id, code, name)`;

/** The list's filter contract, as the query string carries it.
 *  `creditorNames`/`creditorCodes`/`currencies` are the SERVER-FILTERABLE column
 *  funnels the Purchase Orders grid pushes down so pagination runs over the
 *  filtered set (owner 2026-09-16). Line-level and MRP-derived funnels are not
 *  here — they stay client-side on the loaded page (see PurchaseOrdersListV2). */
export type PoListFilters = {
  status: string | null;
  supplierId: string | null;
  q: string | null;
  from: string | null;
  to: string | null;
  sort: string | null;
  creditorNames: string[] | null;
  creditorCodes: string[] | null;
  currencies: string[] | null;
};

const param = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);

/* Multi-value funnel params ride as a JSON array in ONE query param, not a
   comma-joined string: a creditor name may itself contain a comma. A malformed
   or empty value reads as "no filter" (null), never a crash. */
function jsonArrayParam(v: string | undefined): string[] | null {
  if (v === undefined || v === '') return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export function readPoListFilters(query: (key: string) => string | undefined): PoListFilters {
  return {
    status: param(query('status')),
    supplierId: param(query('supplierId')),
    q: param(query('q')),
    from: param(query('from')),
    to: param(query('to')),
    sort: param(query('sort')),
    creditorNames: jsonArrayParam(query('creditorNames')),
    creditorCodes: jsonArrayParam(query('creditorCodes')),
    currencies: jsonArrayParam(query('currencies')),
  };
}

/** The SELECT for the list read. When a creditor funnel is active the supplier
 *  embed becomes `!inner` so a `supplier.name`/`supplier.code` filter removes the
 *  parent PO (a plain embed would only null the embed and keep every PO). Shared
 *  by the list and both exports so all three match the same set. */
export function poListSelect(f: PoListFilters): string {
  const creditorFilter =
    (f.creditorNames !== null && f.creditorNames.length > 0) ||
    (f.creditorCodes !== null && f.creditorCodes.length > 0);
  const supplierEmbed = creditorFilter
    ? 'supplier:suppliers!inner(id, code, name, contact_person, phone, email, address)'
    : 'supplier:suppliers(id, code, name, contact_person, phone, email, address)';
  return `${PO_HEADER_COLS}, ${supplierEmbed}, items:purchase_order_items(item_code, material_name, qty, supplier_sku), purchase_location:warehouses!purchase_location_id(id, code, name)`;
}

/* Indexed by a caller's string, so an unknown key is `undefined` — say so. */
const BUCKETS: Readonly<Record<string, string[] | undefined>> = PO_STATUS_BUCKETS;

const SORT_COLS = new Set(['po_date', 'po_number', 'status', 'total_sen']);

export function poListSort(sort: string | null): { col: string; asc: boolean } {
  const [rawCol, rawDir] = (sort ?? 'po_date:desc').split(':');
  return { col: rawCol !== undefined && SORT_COLS.has(rawCol) ? rawCol : 'po_date', asc: rawDir === 'asc' };
}

/* The PostgREST builder surface these functions use. The functions take and
   return the caller's own builder type and assert this shape INSIDE: matching
   the real supabase-js builder against it at the call site makes tsc give up
   with TS2589 (the same trap lib/po-line-order.ts records). */
type Filterable = {
  order(col: string, opts: { ascending: boolean }): Filterable;
  in(col: string, vals: string[]): Filterable;
  eq(col: string, val: unknown): Filterable;
  or(filters: string): Filterable;
  gte(col: string, val: unknown): Filterable;
  lte(col: string, val: unknown): Filterable;
};

/** ORDER BY the list's sort, with po_number as the unique tiebreaker so range
 *  paging can neither skip nor repeat rows sharing the sort key. */
export function orderPoList<Q>(q: Q, sort: string | null): Q {
  const { col, asc } = poListSort(sort);
  let out = (q as unknown as Filterable).order(col, { ascending: asc });
  if (col !== 'po_number') out = out.order('po_number', { ascending: asc });
  return out as unknown as Q;
}

/** Tab + supplier + COMPANY + search + date range. `validStatuses` is the raw
 *  status vocabulary a non-bucket `status` must belong to — VALID_STATUSES in
 *  routes/mfg-purchase-orders.ts, which stays declared there on purpose
 *  (tests/purchaseDocVocab.test.ts). */
export function filterPoList<Q>(q: Q, f: PoListFilters, c: CompanyScopeCtx, validStatuses: ReadonlySet<string>): Q {
  let out = q as unknown as Filterable;
  /* Resolve the incoming `status`: a known bucket key → all its raw statuses;
     'all'/empty → no filter; otherwise a raw DB status (validStatuses guard).
     The `on_hold` tab reads the MARKER (mig 0324). A held order appears under
     BOTH its real status and On Hold — the point of a marker — so the counts
     do not sum to `all`, exactly as `outstanding` already does not. */
  if (f.status && f.status !== 'all') {
    if (f.status === 'on_hold') out = out.or(HELD_OR_TERM);
    else if (BUCKETS[f.status]) out = out.in('status', BUCKETS[f.status]!);
    else if (validStatuses.has(f.status)) out = out.eq('status', f.status);
  }
  if (f.supplierId) out = out.eq('supplier_id', f.supplierId);
  /* Server-filterable column funnels (owner 2026-09-16): Creditor Name / Code
     via the `supplier` embed (poListSelect makes it `!inner` so these remove the
     parent PO, not just null the embed), Currency on the base column. Multi-value
     via `in`. The grid pushes the ticked values so pagination runs over the
     filtered set. */
  if (f.creditorNames && f.creditorNames.length > 0) out = out.in('supplier.name', f.creditorNames);
  if (f.creditorCodes && f.creditorCodes.length > 0) out = out.in('supplier.code', f.creditorCodes);
  if (f.currencies && f.currencies.length > 0) out = out.in('currency', f.currencies);
  out = scopeToCompany(out, c); // multi-company: isolate to the active company
  /* free-text search over the base-table text columns. Supplier name / code are
     embedded resources, not base purchase_orders columns, so they can't be
     ilike'd here. */
  if (f.q) {
    const s = escapeForOr(f.q);
    if (s) out = out.or(`po_number.ilike.%${s}%,notes.ilike.%${s}%`);
  }
  if (f.from) out = out.gte('po_date', f.from);
  if (f.to) out = out.lte('po_date', f.to);
  return out as unknown as Q;
}

type GrnRow = { id: string; purchase_order_id: string | null; grn_number: string | null };
type GrnReader = {
  from(table: 'grns'): {
    select(cols: string): {
      in(col: string, vals: string[]): {
        neq(col: string, val: string): {
          order(col: string, opts: { ascending: boolean }): {
            order(col: string, opts: { ascending: boolean }): {
              range(from: number, to: number): PromiseLike<{ data: GrnRow[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
    };
  };
};

/* Tier 2 downstream-lock (mirror computeGrnFlags in lib/grn-consumption-flags):
   the non-cancelled GRNs each PO was received into. Powers both `has_children`
   (the list hides Edit / Cancel on a downstream-locked PO) and the "GRN No"
   column (owner 2026-07-02); `id` rides along because GRN detail routes by UUID
   (owner 2026-07-31). The GRN read carries no company predicate of its own: it
   is keyed by PO ids that were themselves read under the company scope.

   Batched by URL size (chunkIn): the list asks for one page (at most 100 POs),
   the header export for every PO a tab matches, and an `in.(…)` list of that
   many uuids is refused at the gateway (lib/paginate-all.ts). Each batch holds
   whole POs, so a PO's GRNs still arrive in grn_number order. */
export async function stampPoListGrns<R extends { id: string }>(
  sb: unknown,
  rows: R[],
): Promise<{
  error: string | null;
  rows: Array<R & { has_children: boolean; transfer_to_grns: Array<{ id: string; grnNumber: string }> }>;
}> {
  const childIds = new Set<string>();
  const grnsByPo = new Map<string, Array<{ id: string; grnNumber: string }>>();
  if (rows.length > 0) {
    const { data: grnRows, error } = await chunkIn<GrnRow>(rows.map((r) => r.id), (batch, from, to) =>
      (sb as GrnReader)
        .from('grns')
        .select('id, purchase_order_id, grn_number')
        .in('purchase_order_id', batch)
        .neq('status', 'CANCELLED')
        .order('grn_number', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to));
    /* A failed read is REPORTED, never served as "no GRNs": has_children is the
       downstream lock, and reading it as false would offer Edit / Cancel on a
       received order. */
    if (error) return { error: error.message, rows: [] };
    for (const g of grnRows) {
      if (!g.purchase_order_id) continue;
      childIds.add(g.purchase_order_id);
      if (!g.grn_number) continue;
      const arr = grnsByPo.get(g.purchase_order_id) ?? [];
      if (!arr.some((x) => x.grnNumber === g.grn_number)) arr.push({ id: g.id, grnNumber: g.grn_number });
      grnsByPo.set(g.purchase_order_id, arr);
    }
  }
  return { error: null, rows: rows.map((r) => ({ ...r, has_children: childIds.has(r.id), transfer_to_grns: grnsByPo.get(r.id) ?? [] })) };
}
