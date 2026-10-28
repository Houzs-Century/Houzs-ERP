// ----------------------------------------------------------------------------
// si-list-read — what the Sales Invoices LIST matches, in one place.
//
// The list (GET /sales-invoices?page=) and its export
// (GET /sales-invoices/export/rows) must match the SAME
// invoices for the same tab, search and sort — and for the same SALES SCOPE:
// a seller who sees only their own and their downline's invoices on the list
// must get exactly those in the file. Every reader builds its query through
// these functions. Same shape as lib/po-list-read.ts (docs/bugs/0916).
// ----------------------------------------------------------------------------

import { SI_STATUS_BUCKETS } from './si-status-buckets';
import { escapeForOr, phoneSearchOrParts } from './postgrest-search';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { inArm } from './so-ref-search';
import { normalizePhone } from '../shared';

/* Full SI header — mirrors the editable DO header shape. */
export const SI_HEADER_COLS =
  'id, invoice_number, so_doc_no, delivery_order_id, debtor_code, debtor_name, ' +
  'invoice_date, due_date, customer_delivery_date, currency, ' +
  'subtotal_sen, discount_sen, tax_sen, total_sen, paid_sen, ' +
  'salesperson_id, agent, email, customer_type, building_type, branding, venue, venue_id, ref, ' +
  'customer_so_no, po_doc_no, sales_location, customer_state, customer_country, note, ' +
  'address1, address2, city, state, postcode, phone, ' +
  'emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, ' +
  'mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, service_sen, ' +
  'mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, others_cost_sen, service_cost_sen, ' +
  'local_total_sen, total_cost_sen, total_margin_sen, margin_pct_basis, line_count, ' +
  'status, notes, sent_at, paid_at, confirmed_at, created_at, created_by, updated_at';

/* The list's select: the header and the AutoCount invoice number. */
export const SI_LIST_SELECT = `${SI_HEADER_COLS}, linked_ac_docno`;

/** The list's filter contract, as the query string carries it. */
export type SiListFilters = {
  status: string | null;
  q: string | null;
  from: string | null;
  to: string | null;
  sort: string | null;
  /** Server-filterable column funnels (owner 2026-09-16): Customer (debtor) Name
     and Currency (base columns). Debtor CODE + line-level / MRP funnels stay
     client-side on the loaded page. */
  debtorNames: string[] | null;
  currencies: string[] | null;
  /** SOs whose reference matches `q` (lib/so-ref-search.ts): the SI's own ref
      copy is empty on many rows, so the SO link is matched instead. */
  soRefDocNos: string[];
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

export function readSiListFilters(query: (key: string) => string | undefined): SiListFilters {
  return {
    status: param(query('status')),
    q: param(query('q')),
    from: param(query('from')),
    to: param(query('to')),
    sort: param(query('sort')),
    debtorNames: jsonArrayParam(query('debtorNames')),
    currencies: jsonArrayParam(query('currencies')),
    soRefDocNos: [],
  };
}

/* Indexed by a caller's string, so an unknown key is `undefined` — say so. */
const BUCKETS: Readonly<Record<string, string[] | undefined>> = SI_STATUS_BUCKETS;

const SORT_COLS = new Set(['invoice_date', 'invoice_number', 'debtor_name', 'status', 'total_sen']);

export function siListSort(sort: string | null): { col: string; asc: boolean } {
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
export function orderSiList<Q>(q: Q, sort: string | null): Q {
  const { col, asc } = siListSort(sort);
  let out = (q as unknown as Filterable).order(col, { ascending: asc });
  if (col !== 'invoice_number') out = out.order('invoice_number', { ascending: asc });
  return out as unknown as Q;
}

/** Sales scope + tab + COMPANY + search + date range.
 *
 *  `scopeIds` is resolveSalesScopeIds' answer (lib/salesScope.ts) and is
 *  REQUIRED: null means the caller may view every seller's invoices, an array
 *  means only those sellers'. An optional parameter here would let a caller
 *  that forgot it export every invoice to a seller who sees three. */
export function filterSiList<Q>(q: Q, f: SiListFilters, c: CompanyScopeCtx, scopeIds: string[] | null): Q {
  let out = q as unknown as Filterable;
  if (scopeIds) out = out.in('salesperson_id', scopeIds);
  if (f.status && f.status !== 'all') {
    if (BUCKETS[f.status]) out = out.in('status', BUCKETS[f.status]!);
    else out = out.eq('status', f.status);
  }
  out = scopeToCompany(out, c); // multi-company: isolate to the active company
  /* Customer NAME, PHONE and the linked SO REFERENCE (ref, snapshotted onto the
     SI), plus the doc numbers — the base-table columns the list searches. */
  if (f.q) {
    const s = escapeForOr(f.q);
    if (s) out = out.or([
      `invoice_number.ilike.%${s}%`, `so_doc_no.ilike.%${s}%`, `debtor_name.ilike.%${s}%`,
      `debtor_code.ilike.%${s}%`, `ref.ilike.%${s}%`, `branding.ilike.%${s}%`, `sales_location.ilike.%${s}%`,
      ...phoneSearchOrParts(s, f.q, normalizePhone),
      ...inArm('so_doc_no', f.soRefDocNos),
    ].join(','));
  }
  if (f.from) out = out.gte('invoice_date', f.from);
  if (f.to) out = out.lte('invoice_date', f.to);
  /* Server-filterable column funnels (owner 2026-09-16) — Customer Name /
     Currency pushed down so the pager runs over the filtered set. */
  if (f.debtorNames && f.debtorNames.length > 0) out = out.in('debtor_name', f.debtorNames);
  if (f.currencies && f.currencies.length > 0) out = out.in('currency', f.currencies);
  return out as unknown as Q;
}
