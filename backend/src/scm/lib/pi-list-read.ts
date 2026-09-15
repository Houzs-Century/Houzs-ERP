// ----------------------------------------------------------------------------
// pi-list-read — what the Purchase Invoices LIST matches, in one place.
//
// The list (GET /purchase-invoices?page=) and its export
// (GET /purchase-invoices/export/rows) must match the SAME
// invoices for the same tab, search and sort. Every reader builds its query
// through these functions, so a filter added here reaches both. Same shape
// as lib/po-list-read.ts (docs/bugs/0916 has the defect this replaces).
//
// Lives here, not in routes/purchase-invoices.ts, because that router is kept
// under its file-size ceiling.
// ----------------------------------------------------------------------------

import { PI_STATUS_BUCKETS } from './pi-status-buckets';
import { HELD_OR_TERM, HOLD_COLUMNS } from './document-hold';
import { escapeForOr } from './postgrest-search';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';

export const PI_HEADER_COLS =
  'id, invoice_number, supplier_invoice_ref, supplier_id, purchase_order_id, grn_id, invoice_date, due_date, currency, exchange_rate, subtotal_sen, tax_sen, total_sen, paid_sen, status, notes, posted_at, created_at, created_by, updated_at, ' + HOLD_COLUMNS; // HOLD_COLUMNS = mig 0324's marker, BESIDE the status pill

/* Supplier CONTACT fields ride the list embed — the quick-view drawer's
   SUPPLIER panel renders off the list row (owner 2026-07-24: all "—"). */
export const PI_LIST_SELECT =
  `${PI_HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, address), purchase_order:purchase_orders(id, po_number), grn:grns(id, grn_number, delivery_note_ref), linked_ac_docno`;

/** The list's filter contract, as the query string carries it. */
export type PiListFilters = {
  status: string | null;
  q: string | null;
  from: string | null;
  to: string | null;
  sort: string | null;
};

const param = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);

export function readPiListFilters(query: (key: string) => string | undefined): PiListFilters {
  return {
    status: param(query('status')),
    q: param(query('q')),
    from: param(query('from')),
    to: param(query('to')),
    sort: param(query('sort')),
  };
}

/* Indexed by a caller's string, so an unknown key is `undefined` — say so. */
const BUCKETS: Readonly<Record<string, string[] | undefined>> = PI_STATUS_BUCKETS;

const SORT_COLS = new Set(['invoice_date', 'invoice_number', 'status', 'total_sen']);

export function piListSort(sort: string | null): { col: string; asc: boolean } {
  const [rawCol, rawDir] = (sort ?? 'invoice_date:desc').split(':');
  return { col: SORT_COLS.has(rawCol) ? rawCol : 'invoice_date', asc: rawDir === 'asc' };
}

type Filterable = {
  order(col: string, opts: { ascending: boolean }): Filterable;
  in(col: string, vals: string[]): Filterable;
  eq(col: string, val: unknown): Filterable;
  or(filters: string): Filterable;
  gte(col: string, val: unknown): Filterable;
  lte(col: string, val: unknown): Filterable;
};

/** ORDER BY the list's sort, invoice_number as the unique tiebreaker so range
 *  paging can neither skip nor repeat rows sharing the sort key. */
export function orderPiList<Q>(q: Q, sort: string | null): Q {
  const { col, asc } = piListSort(sort);
  let out = (q as unknown as Filterable).order(col, { ascending: asc });
  if (col !== 'invoice_number') out = out.order('invoice_number', { ascending: asc });
  return out as unknown as Q;
}

/** Tab + COMPANY + search + date range. */
export function filterPiList<Q>(q: Q, f: PiListFilters, c: CompanyScopeCtx): Q {
  let out = q as unknown as Filterable;
  /* A known bucket key → all its raw statuses; 'all'/empty → no filter;
     otherwise a raw DB status. The `on_hold` tab reads the MARKER (mig 0324). */
  if (f.status && f.status !== 'all') {
    if (f.status === 'on_hold') out = out.or(HELD_OR_TERM);
    else if (BUCKETS[f.status]) out = out.in('status', BUCKETS[f.status]!);
    else out = out.eq('status', f.status);
  }
  out = scopeToCompany(out, c); // multi-company: isolate to the active company
  /* free-text search over the base-table text columns the list searches.
     Supplier name / PO / GRN source are embedded resources, not base
     purchase_invoices columns, so they can't be ilike'd here. */
  if (f.q) {
    const s = escapeForOr(f.q);
    if (s) out = out.or(`invoice_number.ilike.%${s}%,supplier_invoice_ref.ilike.%${s}%,notes.ilike.%${s}%`);
  }
  if (f.from) out = out.gte('invoice_date', f.from);
  if (f.to) out = out.lte('invoice_date', f.to);
  return out as unknown as Q;
}
