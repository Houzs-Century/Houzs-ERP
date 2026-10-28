// The second-level Sales Order list filters, as PostgREST predicates.
//
// The model (fields, operators, validation, date presets) lives in
// scm/shared/so-list-filter-model.ts and is shared byte-for-byte with the
// frontend. This file only answers "which column, which operator" for each row,
// so the list handler can apply ONE function to the page query, the money
// aggregate and the status counts — the three reads that must filter the same
// set, or the header totals and the pill counts disagree with the rows.
//
// Every value reaches PostgREST as a bound query parameter through supabase-js;
// nothing here builds SQL. The two places a value is interpolated into an
// `.or()` string pass it through escapeForOr first, the same guard the list's
// free-text search uses.
//
// "Created by is me": `created_by` on a native order holds the SCM bridge's
// pinned SYSTEM staff uuid, not the person (scm/middleware/auth.ts sets
// user.id = SCM_SYSTEM_STAFF_ID and the create path writes created_by: user.id),
// so filtering on it would match every native order or none. The order's person
// is its salesperson — the same fact the row-level sales scope keys on — so
// both "Created by" and "Salesperson" read `salesperson_id`.

import {
  soDateFilterWindow,
  soFilterField,
  soFilterIsComplete,
  soMoneyToSen,
  soRangeEnds,
  soAddDays,
  soTodayYmd,
  soCategoryBucket,
  parseSoListFilters,
  type SoListFilter,
} from '../shared/so-list-filter-model';
import { normalizePhone } from '../shared/phone';
import { escapeForOr, phoneSearchOrParts } from './postgrest-search';

const MATCH_NOTHING_STAFF_ID = '00000000-0000-0000-0000-000000000000';
const SO_VIEW = 'mfg_sales_orders_with_payment_totals';
const SO_TABLE = 'mfg_sales_orders';

/* Header columns only — every one exists on the base table and on the
   payment-totals view (mig 20260911T1500 enumerates them), except the two
   view-computed money columns noted below. */
const TEXT_COLUMN: Record<string, string> = {
  branding: 'branding',
  venue: 'venue',
  state: 'customer_state',
  city: 'city',
  salesLocation: 'sales_location',
  name: 'debtor_name',
  customerType: 'customer_type',
  buildingType: 'building_type',
  email: 'email',
};
const TEXT_OR_COLUMNS: Partial<Record<string, readonly string[]>> = {
  reference: ['ref', 'customer_so_no'],
  remarks: ['note', 'remark2', 'remark3', 'remark4'],
};
const DATE_COLUMN: Partial<Record<string, string>> = {
  processingDate: 'processing_date',
  deliveryDate: 'customer_delivery_date',
  orderDate: 'so_date',
};
const TIMESTAMP_COLUMN: Record<string, string> = {
  createdDate: 'created_at',
  lastChangeDate: 'updated_at',
};
/* balance_sen_live / paid_total_sen are COMPUTED by the view (Σ payments), so
   they do not exist on the base table — see soListCountSource. */
const MONEY_COLUMN: Record<string, string> = {
  balance: 'balance_sen_live',
  total: 'local_total_sen',
};
/* "Not delivered" — the statuses at or past the goods leaving, plus cancelled.
   SHIPPED folds into the Delivered tab (owner 2026-08-22), so it counts as out. */
const OUT_OF_DOOR = '(SHIPPED,DELIVERED,INVOICED,CLOSED,CANCELLED)';

const KL_MIDNIGHT = (ymd: string) => `${ymd}T00:00:00+08:00`;

export interface SoListFilterContext {
  /** The caller's own staff ids, for "is me". Resolve with resolveOwnStaffIds
   *  when soListFiltersNeedMe is true; pass [] otherwise. */
  myStaffIds: readonly string[];
  /** Today in Kuala Lumpur (soTodayYmd), for presets and "overdue". */
  todayYmd: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the SCM PostgREST client is untyped throughout (see salesScope.ts); the same closure is applied to a page builder, an aggregate builder and a head-count builder. */
function applyOne(q: any, f: SoListFilter, ctx: SoListFilterContext): any {
  const def = soFilterField(f.field);
  if (!def || !soFilterIsComplete(f)) throw new Error(`invalid filter: ${f.field}:${f.op}`);
  switch (def.kind) {
    case 'person':
      return f.op === 'me'
        ? q.in('salesperson_id', ctx.myStaffIds.length > 0 ? [...ctx.myStaffIds] : [MATCH_NOTHING_STAFF_ID])
        : q.eq('salesperson_id', f.value);
    /* The three line/amendment questions read the computed fields added by
       migrations-pg 20260914T1600 (functions over the view's row), so they are
       one more WHERE term on the same page / money / count query. */
    case 'warehouse':
      return q.overlaps('so_line_warehouse_ids', [f.value]);
    case 'text': {
      const v = f.value.trim();
      const orCols = TEXT_OR_COLUMNS[f.field];
      if (orCols) {
        const s = escapeForOr(v);
        const pat = f.op === 'is' ? s : `%${s}%`;
        return q.or(orCols.map((col) => `${col}.ilike.${pat}`).join(','));
      }
      if (f.field === 'contactNo') {
        return q.or(phoneSearchOrParts(escapeForOr(v), v, normalizePhone).join(','));
      }
      return q.ilike(TEXT_COLUMN[f.field], f.op === 'is' ? v : `%${v}%`);
    }
    case 'docRange': {
      const [from, to] = soRangeEnds(f.value);
      let out = q;
      if (from) out = out.gte('doc_no', from);
      if (to) out = out.lte('doc_no', to);
      return out;
    }
    case 'date': {
      const { from, to } = soDateFilterWindow(f, ctx.todayYmd);
      const dateCol = DATE_COLUMN[f.field];
      let out = q;
      if (dateCol) {
        if (from) out = out.gte(dateCol, from);
        if (to) out = out.lte(dateCol, to);
        return out;
      }
      const tsCol = TIMESTAMP_COLUMN[f.field];
      if (from) out = out.gte(tsCol, KL_MIDNIGHT(from));
      if (to) out = out.lt(tsCol, KL_MIDNIGHT(soAddDays(to, 1)));
      return out;
    }
    case 'money': {
      const col = MONEY_COLUMN[f.field];
      if (f.op === 'positive') return q.gt(col, 0);
      if (f.op === 'between') {
        const [a, b] = soRangeEnds(f.value);
        let out = q;
        if (a) out = out.gte(col, soMoneyToSen(a));
        if (b) out = out.lte(col, soMoneyToSen(b));
        return out;
      }
      return q[f.op](col, soMoneyToSen(f.value));
    }
    case 'choice':
      if (f.field === 'itemCategory') return q.overlaps('so_line_categories', [soCategoryBucket(f.value)]);
      if (f.field === 'pendingAmendment') return q.is('so_has_open_amendment', f.value === 'yes');
      if (f.field === 'paymentStatus') {
        if (f.value === 'unpaid') return q.lte('paid_total_sen', 0).gt('balance_sen_live', 0);
        if (f.value === 'deposit') return q.gt('paid_total_sen', 0).gt('balance_sen_live', 0);
        return q.lte('balance_sen_live', 0);
      }
      return q
        .or(`amended_delivery_date.lt.${ctx.todayYmd},and(amended_delivery_date.is.null,customer_delivery_date.lt.${ctx.todayYmd})`)
        .not('status', 'in', OUT_OF_DOOR);
  }
}

/** Append every row's predicate to `q` (rows AND together). Throws on a row the
 *  shared parser would refuse — callers parse first and answer 400. */
export function applySoListFilters<T>(q: T, filters: readonly SoListFilter[], ctx: SoListFilterContext): T {
  let out: any = q;
  for (const f of filters) out = applyOne(out, f, ctx);
  return out as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function soListFiltersNeedMe(filters: readonly SoListFilter[]): boolean {
  return filters.some((f) => f.op === 'me');
}

/** Which relation the status counts read. The counts historically read the base
 *  table (cheaper: no payment join) and nothing about that changes when no
 *  filter is set. With filters they must read the view, because Balance,
 *  Payment status and Total compare view-computed columns and the counts must
 *  count exactly the set the page shows. */
export function soListCountSource(filters: readonly SoListFilter[]): typeof SO_TABLE | typeof SO_VIEW {
  return filters.length > 0 ? SO_VIEW : SO_TABLE;
}

/** The signed-in user's staff ids (scm.staff.user_id → id), for "is me". A user
 *  with no staff row matches nothing; a failed lookup is an error, never an
 *  empty list read as "you have no orders". */
export async function resolveOwnStaffIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped SCM PostgREST client
  sb: any,
  houzsUserId: number | null,
): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
  if (houzsUserId == null || !Number.isFinite(houzsUserId)) return { ok: true, ids: [MATCH_NOTHING_STAFF_ID] };
  const { data, error } = await sb.from('staff').select('id').eq('user_id', houzsUserId);
  if (error) return { ok: false, reason: String(error.message ?? error) };
  const ids = ((data ?? []) as Array<{ id?: string }>).map((r) => r.id).filter((x): x is string => !!x);
  return { ok: true, ids: ids.length > 0 ? ids : [MATCH_NOTHING_STAFF_ID] };
}

export type PreparedSoListFilters =
  | { ok: true; apply: <T>(q: T) => T; countFrom: typeof SO_TABLE | typeof SO_VIEW }
  | { ok: false; status: 400 | 500; body: { error: string; invalid?: string[]; reason?: string } };

/** Everything the list handler needs from the raw `f` params in ONE call:
 *  validation (400 naming each refused row), the "me" lookup (500 when it
 *  fails), and a single `apply` the page, money and count reads all share. */
export async function prepareSoListFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped SCM PostgREST client
  sb: any,
  rawParams: readonly string[],
  houzsUserId: number | null,
  now: Date,
): Promise<PreparedSoListFilters> {
  const { filters, invalid } = parseSoListFilters(rawParams);
  if (invalid.length > 0) return { ok: false, status: 400, body: { error: 'invalid_filter', invalid } };
  let myStaffIds: string[] = [];
  if (soListFiltersNeedMe(filters)) {
    const me = await resolveOwnStaffIds(sb, houzsUserId);
    if (!me.ok) return { ok: false, status: 500, body: { error: 'load_failed', reason: `filter owner lookup failed: ${me.reason}` } };
    myStaffIds = me.ids;
  }
  const ctx: SoListFilterContext = { myStaffIds, todayYmd: soTodayYmd(now) };
  return { ok: true, apply: (q) => applySoListFilters(q, filters, ctx), countFrom: soListCountSource(filters) };
}
