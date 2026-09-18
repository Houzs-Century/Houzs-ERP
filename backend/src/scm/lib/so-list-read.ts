// ----------------------------------------------------------------------------
// so-list-read — what the Sales Order LIST matches, in one place.
//
// The list (GET /mfg-sales-orders?page=), its money strip, and the line export
// (GET /mfg-sales-orders/export/lines) must match the SAME orders for the same
// tab, search, date window and second-level filter rows (`?f=`). Until
// 2026-09-15 the predicate set was written out twice inside the list handler —
// once for the page, once for the money strip — and the copies had already
// drifted: the page searched the customer's phone, the money strip did not
// (docs/bugs, "the Sales Order money strip ignored a phone search"). Every
// reader now builds its query through prepareSoListRead, so a filter added here
// reaches all of them at once, the same move lib/po-list-read.ts made for the
// Purchase Order list.
//
// Lives here, not in routes/mfg-sales-orders.ts, because that router is over
// its file-size ceiling.
// ----------------------------------------------------------------------------

import { HELD_OR_TERM } from './document-hold';
import { effectiveStatusFilter } from './so-list-filters';
import { soStatusesForTab } from './so-tab-statuses';
import { escapeForOr, phoneSearchOrParts } from './postgrest-search';
import { normalizePhone } from '../shared/phone';
import { APPROVAL_CODE_SEARCH_CAP, approvalCodeOrPart } from './so-list-approval-codes';
import { applySoScope } from './salesScope';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { prepareSoListFilters } from './so-list-query-filters';
import { SO_STATUSES } from './so-lifecycle-guards';

/** The list's filter contract, as the query string carries it. */
export type SoListParams = {
  status: string | null;
  q: string | null;
  sort: string | null;
  from: string | null;
  to: string | null;
  /** The second-level filter rows, one `f` param each (so-list-filter-model). */
  f: string[];
  /** Server-filterable column funnels the grid pushes down (owner 2026-09-16) so
     pagination runs over the filtered set: Customer (debtor) Name and Currency,
     both base columns on the list view. Debtor CODE stays client-side — its grid
     value prefers ac_debtor_code over the base debtor_code, so it is not a clean
     base-column filter. */
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

export function readSoListParams(
  query: (key: string) => string | undefined,
  queries: (key: string) => string[] | undefined,
): SoListParams {
  return {
    status: param(query('status')),
    q: param(query('q')),
    sort: param(query('sort')),
    from: param(query('from')),
    to: param(query('to')),
    f: queries('f') ?? [],
    debtorNames: jsonArrayParam(query('debtorNames')),
    currencies: jsonArrayParam(query('currencies')),
  };
}

/* The backend sort whitelist — anything else falls back to so_date. */
const SORT_COLS = new Set(['so_date', 'doc_no', 'debtor_name', 'status', 'local_total_sen', 'customer_delivery_date']);

export function soListSort(sort: string | null): { col: string; asc: boolean } {
  const [rawCol, rawDir] = (sort ?? 'so_date:desc').split(':');
  return { col: SORT_COLS.has(rawCol) ? rawCol : 'so_date', asc: rawDir === 'asc' };
}

type Orderable = { order(col: string, opts: { ascending: boolean }): Orderable };

/** ORDER BY the list's sort, with doc_no as the unique tiebreaker so range
 *  paging can neither skip nor repeat rows sharing the sort key. */
export function orderSoList<Q>(q: Q, sort: string | null): Q {
  const { col, asc } = soListSort(sort);
  let out = (q as unknown as Orderable).order(col, { ascending: asc });
  if (col !== 'doc_no') out = out.order('doc_no', { ascending: asc });
  return out as unknown as Q;
}

export type SoListRead =
  | {
      ok: true;
      /** Sales scope + company + second-level filters + tab + search + date
       *  window: every predicate the list's rows answer to. */
      header: <T>(q: T) => T;
      /** Sales scope + company + second-level filters only — the status counts,
       *  which must not narrow by the tab they are counting. */
      scoped: <T>(q: T) => T;
      /** Which relation the status counts read (so-list-query-filters). */
      countFrom: 'mfg_sales_orders' | 'mfg_sales_orders_with_payment_totals';
    }
  | { ok: false; status: 400 | 500; body: { error: string; invalid?: string[]; reason?: string } };

type Filterable = {
  eq(col: string, val: unknown): Filterable;
  in(col: string, vals: string[]): Filterable;
  or(filters: string): Filterable;
  gte(col: string, val: unknown): Filterable;
  lte(col: string, val: unknown): Filterable;
};

/** The list's own relation, selected — the page, the line export and the check
 *  script start their read here and narrow it with `header`. The search terms
 *  below run against it (the trigram audit reads them off this call). */
export function fromSoList(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout (see salesScope.ts)
  sb: any,
  cols: string,
  opts?: { count: 'exact' },
) {
  return sb.from('mfg_sales_orders_with_payment_totals').select(cols, opts);
}

/**
 * Validate and resolve the list's filters ONCE: the second-level rows (400 on a
 * refused row, 500 when the "is me" lookup fails) and the approval-code search
 * (500 when that read fails — a search that silently dropped its matches would
 * be a wrong answer, not an empty one). `scopeIds` is the caller's row-level
 * sales scope (resolveSalesScopeIds; null = view-all).
 */
export async function prepareSoListRead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout (see salesScope.ts)
  sb: any,
  c: CompanyScopeCtx,
  p: SoListParams,
  scopeIds: string[] | null,
  houzsUserId: number | null,
  now: Date,
): Promise<SoListRead> {
  const soFilter = await prepareSoListFilters(sb, p.f, houzsUserId, now);
  if (!soFilter.ok) return soFilter;

  const code = await readApprovalCodePart(sb, c, p.q);
  if (!code.ok) return code;
  const codePart = code.part;

  const scoped = <T>(q: T): T => soFilter.apply(scopeToCompany(applySoScope(q, scopeIds), c));

  const status = effectiveStatusFilter(p.status);
  /* status=OTHER → rows whose status is OUTSIDE the known vocabulary (legacy
     spellings / blanks), so the list's "Other" pill can be opened. The ON_HOLD
     tab reads the mig-0324 MARKER, not the status. */
  const otherStatusOr = `status.is.null,status.not.in.(${[...SO_STATUSES].join(',')})`;
  const search = p.q;

  const header = <T>(q0: T): T => {
    let q = scoped(q0) as unknown as Filterable;
    if (status === 'ON_HOLD') q = q.or(HELD_OR_TERM);
    else if (status) {
      const vals = soStatusesForTab(status);
      q = status === 'OTHER' ? q.or(otherStatusOr) : (vals.length === 1 ? q.eq('status', vals[0]) : q.in('status', vals));
    }
    /* free-text search over the reference the list DISPLAYS: customerRefOf is
       `ref || customer_so_no`, so BOTH are searched (bug 0755). Plus doc_no /
       debtor / agent / location / branding, the customer's phone (#816), and
       the approval-code orders read above. */
    if (search) {
      const s = escapeForOr(search);
      if (s) q = q.or([
        `doc_no.ilike.%${s}%`, `debtor_name.ilike.%${s}%`, `debtor_code.ilike.%${s}%`,
        `agent.ilike.%${s}%`, `sales_location.ilike.%${s}%`, `ref.ilike.%${s}%`,
        `customer_so_no.ilike.%${s}%`, `branding.ilike.%${s}%`,
        ...phoneSearchOrParts(s, search, normalizePhone),
        ...(codePart ? [codePart] : []),
      ].join(','));
    }
    /* Optional so_date window (ISO yyyy-mm-dd, inclusive) — the mobile list's
       period chips. */
    if (p.from) q = q.gte('so_date', p.from);
    if (p.to) q = q.lte('so_date', p.to);
    /* Server-filterable column funnels (owner 2026-09-16): Customer Name and
       Currency, pushed down so the pager runs over the filtered set. In `header`
       (not `scoped`) so the list + its count narrow while the status-count pills
       stay full — mirrors how the PO creditor funnel behaves. */
    if (p.debtorNames && p.debtorNames.length > 0) q = q.in('debtor_name', p.debtorNames);
    if (p.currencies && p.currencies.length > 0) q = q.in('currency', p.currencies);
    return q as unknown as T;
  };

  return { ok: true, header, scoped, countFrom: soFilter.countFrom };
}

/* An order is also found by a card payment's APPROVAL CODE (owner 2026-09-15,
   docs/bugs/0909) — Finance reads one off a merchant report and wants the
   order. The code lives on the payment rows, which the header `.or()` cannot
   see, so the orders whose payments carry EXACTLY the typed code are read first
   and admitted as ONE in-list term. An exact match rather than a substring, so
   no trigram index is owed. A failed read refuses the list: a search that
   silently dropped its matches would be a wrong answer, not an empty one. */
async function readApprovalCodePart(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout (see salesScope.ts)
  sb: any,
  c: CompanyScopeCtx,
  q: string | null,
): Promise<{ ok: true; part: string | null } | { ok: false; status: 500; body: { error: string; reason: string } }> {
  let codePart: string | null = null;
  const code = String(q ?? '').trim();
  if (code) {
    const { data, error } = await scopeToCompany(sb.from('mfg_sales_order_payments')
      .select('so_doc_no').eq('approval_code', code).limit(APPROVAL_CODE_SEARCH_CAP), c);
    if (error) return { ok: false, status: 500, body: { error: 'load_failed', reason: `approval codes: ${error.message}` } };
    codePart = approvalCodeOrPart(((data ?? []) as Array<{ so_doc_no: string }>).map((r) => r.so_doc_no));
  }
  return { ok: true, part: codePart };
}
