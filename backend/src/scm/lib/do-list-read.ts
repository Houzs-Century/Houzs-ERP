// ----------------------------------------------------------------------------
// do-list-read — what the Delivery Order LIST matches, in one place.
//
// The list (GET /delivery-orders-mfg?page=) and the line export
// (GET /delivery-orders-mfg/export/lines) must match the SAME delivery orders
// for the same tab, search and sort. Both build their read through these
// functions, so a filter added here reaches both — the move lib/po-list-read.ts
// made for the Purchase Order list.
//
// Lives here, not in routes/delivery-orders-mfg.ts, because that router is over
// its file-size ceiling.
// ----------------------------------------------------------------------------

import { DO_STATUS_BUCKETS } from './do-status-buckets';
import { escapeForOr, phoneSearchOrParts } from './postgrest-search';
import { normalizePhone } from '../shared/phone';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';

/* Indexed by a caller's string, so an unknown key is `undefined` — say so. */
const BUCKETS: Readonly<Record<string, string[] | undefined>> = DO_STATUS_BUCKETS;

/** The list's filter contract, as the query string carries it. */
export type DoListParams = {
  status: string | null;
  q: string | null;
  sort: string | null;
  from: string | null;
  to: string | null;
  /** Server-filterable column funnels (owner 2026-09-16): Customer (debtor) Name
     and Currency (base columns on delivery_orders). Debtor CODE and line-level /
     MRP funnels stay client-side on the loaded page. */
  debtorNames: string[] | null;
  currencies: string[] | null;
};

const param = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);

/* Multi-value funnel params ride as a JSON array in ONE param (a customer name
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

export function readDoListParams(query: (key: string) => string | undefined): DoListParams {
  return {
    status: param(query('status')),
    q: param(query('q')),
    sort: param(query('sort')),
    from: param(query('from')),
    to: param(query('to')),
    debtorNames: jsonArrayParam(query('debtorNames')),
    currencies: jsonArrayParam(query('currencies')),
  };
}

const SORT_COLS = new Set(['do_date', 'do_number', 'debtor_name', 'status', 'customer_delivery_date']);

export function doListSort(sort: string | null): { col: string; asc: boolean } {
  const [rawCol, rawDir] = (sort ?? 'do_date:desc').split(':');
  return { col: SORT_COLS.has(rawCol) ? rawCol : 'do_date', asc: rawDir === 'asc' };
}

type Filterable = {
  order(col: string, opts: { ascending: boolean }): Filterable;
  in(col: string, vals: string[]): Filterable;
  eq(col: string, val: unknown): Filterable;
  or(filters: string): Filterable;
  gte(col: string, val: unknown): Filterable;
  lte(col: string, val: unknown): Filterable;
};

/** ORDER BY the list's sort, with do_number as the unique tiebreaker so range
 *  paging can neither skip nor repeat rows sharing the sort key. */
export function orderDoList<Q>(q: Q, sort: string | null): Q {
  const { col, asc } = doListSort(sort);
  let out = (q as unknown as Filterable).order(col, { ascending: asc });
  if (col !== 'do_number') out = out.order('do_number', { ascending: asc });
  return out as unknown as Q;
}

/** The list's own relation, selected — the list and the line export start their
 *  read here and narrow it with filterDoList, whose search terms run against it
 *  (the trigram audit reads them off this call). */
export function fromDoList(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout (see salesScope.ts)
  sb: any,
  cols: string,
  opts?: { count: 'exact' },
) {
  return sb.from('delivery_orders').select(cols, opts);
}

/** COMPANY + sales scope + tab + search + date window. `scopeIds` is the
 *  caller's row-level sales scope (resolveSalesScopeIds; null = view-all). */
export function filterDoList<Q>(q: Q, p: DoListParams, c: CompanyScopeCtx, scopeIds: string[] | null): Q {
  let out = scopeToCompany(q, c) as unknown as Filterable; // per-company document
  if (scopeIds) out = out.in('salesperson_id', scopeIds);
  /* A known bucket key → all its raw statuses; 'all'/empty → no filter;
     otherwise a raw DB status. The `on_hold` tab reads the MARKER (mig 0324)
     ONLY — never HELD_OR_TERM, whose `status.eq.ON_HOLD` arm 22P02s a do_status
     that has no such label. */
  const status = p.status;
  if (status && status !== 'all') {
    if (status === 'on_hold') out = out.eq('on_hold', true);
    else if (BUCKETS[status]) out = out.in('status', BUCKETS[status]);
    else out = out.eq('status', status);
  }
  /* free-text search over the columns the list's search matches: customer
     name, phone, the linked SO reference, and the doc numbers. */
  if (p.q) {
    const s = escapeForOr(p.q);
    if (s) out = out.or([
      `do_number.ilike.%${s}%`, `so_doc_no.ilike.%${s}%`, `debtor_name.ilike.%${s}%`,
      `debtor_code.ilike.%${s}%`, `ref.ilike.%${s}%`, `branding.ilike.%${s}%`,
      `sales_location.ilike.%${s}%`, `driver_name.ilike.%${s}%`,
      ...phoneSearchOrParts(s, p.q, normalizePhone),
    ].join(','));
  }
  if (p.from) out = out.gte('do_date', p.from);
  if (p.to) out = out.lte('do_date', p.to);
  /* Server-filterable column funnels (owner 2026-09-16) — Customer Name /
     Currency pushed down so the pager runs over the filtered set. */
  if (p.debtorNames && p.debtorNames.length > 0) out = out.in('debtor_name', p.debtorNames);
  if (p.currencies && p.currencies.length > 0) out = out.in('currency', p.currencies);
  return out as unknown as Q;
}
