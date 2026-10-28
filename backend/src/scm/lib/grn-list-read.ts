// ----------------------------------------------------------------------------
// grn-list-read — what the Goods Received LIST matches, in one place.
//
// The list (GET /grns?page=) and its export (GET /grns/export/rows)
// must match the SAME receipts for the same tab, search and
// sort. While the filter lived only inside the list handler, the only export
// there was could not reach it and wrote one screen page instead (the Purchase
// Order list had the same defect, docs/bugs/0916). Every reader builds its
// query through these functions, so a filter added here reaches both.
//
// Same shape as lib/po-list-read.ts. Lives here, not in routes/grns.ts, because
// that router is over its file-size ceiling.
// ----------------------------------------------------------------------------

import { GRN_STATUS_BUCKETS } from './grn-status-buckets';
import { HELD_OR_TERM, HOLD_COLUMNS } from './document-hold';
import { escapeForOr } from './postgrest-search';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';

export const GRN_HEADER_COLS =
  'id, grn_number, purchase_order_id, supplier_id, warehouse_id, received_at, delivery_note_ref, status, notes, ' +
  /* Migration 0101 — GRN ↔ PO money parity; 0082 — exchange_rate (FX→MYR cost) +
     allocation_method (landed-cost "平摊" basis). */
  'currency, exchange_rate, allocation_method, subtotal_sen, tax_sen, total_sen, ' +
  'posted_at, created_at, created_by, updated_at, ' + HOLD_COLUMNS; // mig 0324's marker, BESIDE the status pill

/* warehouse embeds the receiving location's NAME (Owner 2026-07-02 — the GRN
   list "Purchase Location" column). Supplier CONTACT fields ride the embed for
   the quick-view drawer. */
export const GRN_LIST_SELECT =
  `${GRN_HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_order:purchase_orders(id, po_number), warehouse:warehouses!warehouse_id(id, code, name), ` +
  /* The AutoCount GR number's two homes (lib/grn-export-rows.ts grnAcDocNo). */
  'linked_ac_docno, linked_ac_gr_docno, migrated_no_stock';

/** The list's filter contract, as the query string carries it. */
export type GrnListFilters = {
  status: string | null;
  supplierId: string | null;
  q: string | null;
  from: string | null;
  to: string | null;
  sort: string | null;
  /** Server-filterable column funnels (owner 2026-09-16): Creditor Name / Code
     via the supplier embed, Currency on the base column. Line-level / MRP funnels
     stay client-side on the loaded page. */
  creditorNames: string[] | null;
  creditorCodes: string[] | null;
  currencies: string[] | null;
};

const param = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);

/* Multi-value funnel params ride as a JSON array in ONE param (a creditor name
   may contain a comma). Malformed / empty reads as no filter. */
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

export function readGrnListFilters(query: (key: string) => string | undefined): GrnListFilters {
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

/** The SELECT for the GRN list read; the supplier embed becomes `!inner` when a
 *  creditor funnel is active so a `supplier.name`/`supplier.code` filter removes
 *  the parent GRN. Shared by the list and the export. */
export function grnListSelect(f: GrnListFilters): string {
  const creditorFilter =
    (f.creditorNames !== null && f.creditorNames.length > 0) ||
    (f.creditorCodes !== null && f.creditorCodes.length > 0);
  const supplierEmbed = creditorFilter
    ? 'supplier:suppliers!inner(id, code, name, contact_person, phone, email, address)'
    : 'supplier:suppliers(id, code, name, contact_person, phone, email, address)';
  return `${GRN_HEADER_COLS}, ${supplierEmbed}, purchase_order:purchase_orders(id, po_number), warehouse:warehouses!warehouse_id(id, code, name), ` +
    'linked_ac_docno, linked_ac_gr_docno, migrated_no_stock';
}

/* Indexed by a caller's string, so an unknown key is `undefined` — say so. */
const BUCKETS: Readonly<Record<string, string[] | undefined>> = GRN_STATUS_BUCKETS;

const SORT_COLS = new Set(['received_at', 'grn_number', 'status', 'total_sen']);

export function grnListSort(sort: string | null): { col: string; asc: boolean } {
  const [rawCol, rawDir] = (sort ?? 'received_at:desc').split(':');
  return { col: SORT_COLS.has(rawCol) ? rawCol : 'received_at', asc: rawDir === 'asc' };
}

/* The PostgREST builder surface these functions use, asserted INSIDE so the
   caller's own builder type passes through (the TS2589 trap po-list-read.ts
   records). */
type Filterable = {
  order(col: string, opts: { ascending: boolean }): Filterable;
  in(col: string, vals: string[]): Filterable;
  eq(col: string, val: unknown): Filterable;
  or(filters: string): Filterable;
  gte(col: string, val: unknown): Filterable;
  lte(col: string, val: unknown): Filterable;
};

/** ORDER BY the list's sort, grn_number as the unique tiebreaker so range
 *  paging can neither skip nor repeat rows sharing the sort key. */
export function orderGrnList<Q>(q: Q, sort: string | null): Q {
  const { col, asc } = grnListSort(sort);
  let out = (q as unknown as Filterable).order(col, { ascending: asc });
  if (col !== 'grn_number') out = out.order('grn_number', { ascending: asc });
  return out as unknown as Q;
}

/** Tab + supplier + COMPANY + search + date range. */
export function filterGrnList<Q>(q: Q, f: GrnListFilters, c: CompanyScopeCtx): Q {
  let out = q as unknown as Filterable;
  /* A known bucket key → all its raw statuses; 'all'/empty → no filter;
     otherwise a raw DB status. The `on_hold` tab reads the MARKER (mig 0324). */
  if (f.status && f.status !== 'all') {
    if (f.status === 'on_hold') out = out.or(HELD_OR_TERM);
    else if (BUCKETS[f.status]) out = out.in('status', BUCKETS[f.status]!);
    else out = out.eq('status', f.status);
  }
  if (f.supplierId) out = out.eq('supplier_id', f.supplierId);
  out = scopeToCompany(out, c); // multi-company: isolate to the active company
  /* free-text search over the base-table text columns the list searches.
     Supplier name / PO number are embedded resources, not base grns columns,
     so they can't be ilike'd here. */
  if (f.q) {
    const s = escapeForOr(f.q);
    if (s) out = out.or(`grn_number.ilike.%${s}%,delivery_note_ref.ilike.%${s}%,notes.ilike.%${s}%`);
  }
  if (f.from) out = out.gte('received_at', f.from);
  if (f.to) out = out.lte('received_at', f.to);
  /* Server-filterable column funnels (owner 2026-09-16) — Creditor Name / Code
     (grnListSelect makes the supplier embed `!inner`) and Currency, pushed down
     so the pager runs over the filtered set. */
  if (f.creditorNames && f.creditorNames.length > 0) out = out.in('supplier.name', f.creditorNames);
  if (f.creditorCodes && f.creditorCodes.length > 0) out = out.in('supplier.code', f.creditorCodes);
  if (f.currencies && f.currencies.length > 0) out = out.in('currency', f.currencies);
  return out as unknown as Q;
}
