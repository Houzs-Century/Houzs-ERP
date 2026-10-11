// ----------------------------------------------------------------------------
// /payment-audit-log — Finance's PAYMENT TRAIL: one row per
// scm.mfg_sales_order_payments entry, joined to its Sales Order header for
// customer / salesperson / venue / order-total context. Read-only: this route
// never writes.
//
// Port of 2990's GET /admin/audit-log (apps/api/src/routes/audit-log.ts) — one
// of the last Finance surfaces Houzs lacked before 2990's apps/api can retire.
//
// ── THE NAME IS NOT "audit-log", DELIBERATELY ────────────────────────────────
// Two DIFFERENT things already own that word, and conflating them is the risk:
//   · /api/audit (public.audit_events) = role / permission changes.
//   · /mfg-sales-orders/:docNo/audit-log + /consignment-orders/:docNo/audit-log
//     (scm.mfg_so_audit_log) = per-document FIELD-CHANGE history.
// This is neither: it is the MONEY ledger. 2990 mounted it at /admin/audit-log;
// mirroring that path would make "audit-log" mean a THIRD thing in one tree.
// The usual "paths mirror 2990's" rule (scm/index.ts) buys nothing here — no UI
// consumes this yet (backend-only by design; a UI needs an approved mockup
// first), so nothing depended on path parity.
//
// ── GATE: canViewScmFinance, AS A HARD 403 — NOT A COLUMN STRIP ──────────────
// Everywhere else in this tree canViewScmFinance strips cost/margin keys out of
// a payload that still has a legitimate non-finance remainder (a rep must see
// their own order lines). THIS payload has no such remainder: the entire row IS
// the finance artifact — amount, method, approval code, bank slip. A payment
// trail with the money removed is an empty list, so the gate is binary.
//
// The gate CANNOT be the area mount. scmAreaGuard('scm.finance.accounting')
// FAILS OPEN by design: `if (!user.scm_l2_configured) { await next(); }`
// (middleware/area-guard.ts) — any caller without an explicit SCM L2 config
// falls through to the coarse scm.access umbrella. That is correct for page
// access (no lockout before the matrix is seeded) and useless as a boundary for
// a money ledger. So the mount says WHERE this lives; this check says WHO.
//
// Director-only rather than a new permission key, on purpose:
//   · A new key needs a permissions.ts entry, a Team > Positions matrix row and
//     an owner decision about who holds it. Shipping an ungranted key = an
//     endpoint nobody can call, and there is no UI yet to force that decision.
//   · canViewScmFinance is the EXISTING, owner-understood finance tier — already
//     the line for cost/margin on every other SCM surface. Reusing it keeps one
//     answer to "may this person see money", instead of a second one that drifts.
//   · It fails closed (no houzsUser / no director position -> not finance) and
//     reads the REAL caller. NEVER c.get('user') — inside /api/scm/* that is the
//     pinned system staff row, which reports super_admin for everybody (the
//     pos-cart leak, #633).
// Widening later (e.g. a Finance Executive key) is safe; narrowing after Finance
// depends on it is not. See the report note on this decision.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { z } from 'zod';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import { canViewAllSales, canViewScmFinance } from '../lib/houzs-perms';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { PAYMENT_METHOD_CODES } from '../shared/payment-methods';
import { todayMyt } from '../lib/my-time';

export const paymentAuditLog = new Hono<{ Bindings: Env; Variables: Variables }>();
paymentAuditLog.use('*', supabaseAuth);

/* Unbounded reads of a payments ledger are a mistake nobody notices until the
   book is large, so an unfiltered call answers the last 30 days (2990's default,
   kept). todayMyt is the MY calendar helper paid_at itself is stamped from, so
   the default window and the column agree by construction. */
const DEFAULT_RANGE_DAYS = 30;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const QuerySchema = z.object({
  from:           z.string().regex(YMD).optional(),
  to:             z.string().regex(YMD).optional(),
  salespersonId:  z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
  /* 2990 called this `staffId` and filtered mfg_sales_order_payments.created_by
     ("who keyed the payment"). That column is MEANINGLESS in Houzs — see the
     COLLECTED_BY note below — so the filter is named for what it actually is. */
  collectedById:  z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
  paymentMethod:  z.union([z.enum(PAYMENT_METHOD_CODES), z.array(z.enum(PAYMENT_METHOD_CODES))]).optional(),
  /* CENTI on the wire, and the unit is IN THE NAME. 2990 took whole RM here and
     multiplied by 100 server-side, which only worked because its payload was RM
     too. This payload is centi (see MONEY below), so an `amountMin` that meant
     RM while every emitted amount meant sen is a 100x filter bug waiting for the
     first caller who assumes the units match. */
  amountMinCenti: z.coerce.number().int().nonnegative().optional(),
  amountMaxCenti: z.coerce.number().int().nonnegative().optional(),
  slipUploaded:   z.enum(['true', 'false']).optional(),
});

function toArray<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/* MONEY — integers in sen, keys suffixed `_centi`, exactly as every neighbouring
   read emits them (unbilled-deliveries, reports, the SO list). 2990 divided by
   100 and returned RM floats; that is NOT this codebase's convention, and the
   division also does two things a Finance ledger must never do: it introduces
   binary-float error into a reconciliation total, and 2990 wrote it as
   `(so.local_total_centi ?? 0) / 100` — the banned `?? 0`, which reports a
   missing order total as a confident RM 0. Formatting is the FE's job. */
const SELECT =
  'id, so_doc_no, paid_at, created_at, method, merchant_provider, online_type, ' +
  'installment_months, approval_code, amount_centi, account_sheet, note, ' +
  'slip_key, is_deposit, collected_by, ' +
  /* !inner: every payment carries its SO header (so_doc_no is NOT NULL with an
     FK to mfg_sales_orders.doc_no), and the inner join is what lets the
     salesperson filter + the row scope below apply to the embedded resource.
     Inner is also the correct FAIL DIRECTION for the scope: a payment whose SO
     header the caller may not see is DROPPED, never emitted headerless. */
  'so:mfg_sales_orders!inner ( debtor_name, phone, venue, salesperson_id, local_total_centi, slip_key )';

type PaymentRow = {
  id: string;
  so_doc_no: string;
  paid_at: string;
  created_at: string;
  method: string | null;
  merchant_provider: string | null;
  online_type: string | null;
  installment_months: number | null;
  approval_code: string | null;
  amount_centi: number;
  account_sheet: string | null;
  note: string | null;
  slip_key: string | null;
  is_deposit: boolean | null;
  collected_by: string | null;
  so: {
    debtor_name: string | null;
    phone: string | null;
    venue: string | null;
    salesperson_id: string | null;
    local_total_centi: number;
    slip_key: string | null;
  } | null;
};

type Row = {
  id: string;
  so_doc_no: string;
  paid_at: string;
  created_at: string;
  method: string | null;
  merchant_provider: string | null;
  online_type: string | null;
  installment_months: number | null;
  approval_code: string | null;
  account_sheet: string | null;
  note: string | null;
  amount_centi: number;
  is_deposit: boolean;
  slip_key: string | null;
  slip_uploaded: boolean;
  so_slip_key: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  /* null = the header could not be read, NEVER 0. `?? 0` on a money read is
     banned here precisely because it turns "I don't know" into a confident
     RM 0 — and an order total silently reading 0 next to a real payment amount
     is a reconciliation lie. !inner means this cannot happen today; typing it
     nullable keeps the honest answer available if it ever does. */
  so_total_centi: number | null;
  venue: string | null;
  salesperson_id: string | null;
  salesperson: string | null;
  collected_by: string | null;
  collected_by_name: string | null;
};

const emptyPayload = (from: string, to: string | undefined) => ({
  range: { from, to: to ?? null },
  rows: [] as Row[],
  count: 0,
  total_amount_centi: 0,
});

/**
 * GET /payment-audit-log — one row per payment against a Sales Order, newest
 * money first.
 *
 * Query params (all optional):
 *   ?from= / ?to=          paid_at range, YYYY-MM-DD, INCLUSIVE. from defaults
 *                          to 30 days ago; to defaults to open.
 *   ?salespersonId=        scm.staff uuid of the SO's salesperson (repeatable)
 *   ?collectedById=        scm.staff uuid of who took the money (repeatable)
 *   ?paymentMethod=        merchant | transfer | installment | cash (repeatable)
 *   ?amountMinCenti= / ?amountMaxCenti=   payment amount bounds, in SEN
 *   ?slipUploaded=true|false              payment has its own slip attached
 *
 * Returns { range, rows, count, total_amount_centi }. The total is computed over
 * the ROWS RETURNED, so it always reconciles with the list on screen.
 */
paymentAuditLog.get('/', async (c) => {
  if (!canViewScmFinance(c)) {
    /* Plain language, and an `error` CODE the SCM client's ERROR_CODE_MESSAGES
       can curate (authed-fetch.ts reads `error` before `message`) — the reader
       is an operator, not an engineer. */
    return c.json(
      {
        error: 'scm_finance_only',
        message: 'The payment trail shows every customer payment, so it is limited to Finance and management.',
      },
      403,
    );
  }

  /* Hono's c.req.query() returns only the FIRST value for a repeated key, so the
     repeatable filters must be read with c.req.queries() or a two-salesperson
     filter would silently narrow to one. */
  const flat: Record<string, string | string[]> = {};
  for (const key of ['from', 'to', 'amountMinCenti', 'amountMaxCenti', 'slipUploaded']) {
    const v = c.req.query(key);
    if (v !== undefined) flat[key] = v;
  }
  for (const key of ['salespersonId', 'collectedById', 'paymentMethod']) {
    const vs = c.req.queries(key);
    if (vs && vs.length > 0) flat[key] = vs.length === 1 ? (vs[0] as string) : vs;
  }

  const parsed = QuerySchema.safeParse(flat);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const q = parsed.data;

  /* paid_at is `date NOT NULL` (DEFAULT now()) and is INDEXED (idx_msop_paid_at)
     — so this range is a plain MY-calendar string compare with no timezone skew
     and no NULL rows to lose. That is why the window is on paid_at, not on
     2990's `created_at`: created_at is a timestamptz that 2990 bounded with UTC
     midnights, which in a UTC+8 business puts an 8-hour slice of every boundary
     day in the wrong bucket. paid_at is also the column Finance reconciles a
     bank statement against — the date the money LANDED, not the date someone got
     round to keying it. Both dates are still emitted per row. */
  const from = q.from ?? todayMyt(-DEFAULT_RANGE_DAYS);
  const to = q.to;

  const sb = c.get('supabase');

  /* ROW SCOPE — own + full recursive downline, the same source of truth every
     sales-doc list uses (lib/salesScope). Must be fed the REAL Houzs integer id;
     user.id here is the bridge's pinned staff uuid and feeding it to this lookup
     is the documented non-admin 500.

     HONEST NOTE ON WHAT THIS DOES TODAY: nothing, provably. canViewScmFinance is
     isFinanceViewer === getPmsRole(...)==='DIRECTOR', and canViewAllSales admits
     `scm.so.view_all` OR isDirectorUser — which is the SAME predicate
     (`*` wildcard OR a DIRECTOR_POSITION_NAMES match, pmsAccess.ts). So every caller
     who survives the gate above also satisfies canViewAllSales, and
     resolveSalesScopeIds returns null (unrestricted) on its FIRST line, before
     any query — this costs zero DB work.

     It is kept because it is a FUSE, not decoration: the moment the gate widens
     (an owner-granted Finance Executive key is the obvious next ask), this
     endpoint would otherwise become a way around the row rule its own module
     enforces — which is exactly how /reports shipped every rep's book to any
     Sales Executive (fix/c1-reports). The fuse costs nothing and arms itself. */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  /* One filter on so.salesperson_id, not two. The requested filter and the scope
     are intersected HERE rather than chained as two .in() calls on the same
     column: PostgREST ANDs repeated filters, but relying on that makes the
     narrowing implicit, and an empty result would look like "no data" instead of
     "out of scope". An empty intersection short-circuits below — which also
     dodges PostgREST rejecting an empty `in.()` list (400 -> a 500 here). */
  const requestedSalespersonIds = toArray(q.salespersonId);
  let salespersonIds: string[] | undefined;
  if (scopeIds && requestedSalespersonIds) {
    const allowed = new Set(scopeIds);
    salespersonIds = requestedSalespersonIds.filter((id) => allowed.has(id));
  } else {
    salespersonIds = requestedSalespersonIds ?? scopeIds ?? undefined;
  }
  if (salespersonIds && salespersonIds.length === 0) {
    return c.json(emptyPayload(from, to));
  }

  const collectedByIds = toArray(q.collectedById);
  const methods = toArray(q.paymentMethod);

  /* paginateAll, not 2990's .limit(1000): PostgREST caps every response at 1000
     rows and DROPS the rest with NO error, so 2990's limit silently reported the
     first 1000 payments and hid the rest of the money. A Finance trail that
     quietly truncates is worse than one that is slow.
     Left untyped (+ a cast below), as reports.ts / unbilled-deliveries do: the
     scm client is SupabaseClient<any>, so a .select() carrying an embed infers
     as GenericStringError[] rather than the row shape. */
  const { data, error } = await paginateAll((pFrom, pTo) => {
    let qb = sb.from('mfg_sales_order_payments').select(SELECT).gte('paid_at', from);
    if (to) qb = qb.lte('paid_at', to);

    /* MULTI-COMPANY ISOLATION. The SCM client is service-role, so RLS is bypassed
       and this app-layer predicate is the ONLY boundary — an unscoped query here
       is a cross-company leak (the P&L drill-down, #673). Three-state by design
       (lib/companyScope): unresolved -> no predicate (single-company Houzs
       unchanged); granted-no-active-company -> matches nothing; else -> the
       active company. Scoping the DRIVING table is sufficient: a payment
       inherits its SO's company_id, and so_doc_no is globally unique across
       companies (companyDocPrefix), so the joined header is always this
       payment's own SO and can never be another company's. */
    qb = scopeToCompany(qb, c);

    if (salespersonIds) qb = qb.in('so.salesperson_id', salespersonIds);
    if (collectedByIds) qb = qb.in('collected_by', collectedByIds);
    if (methods) qb = qb.in('method', methods);
    if (q.amountMinCenti !== undefined) qb = qb.gte('amount_centi', q.amountMinCenti);
    if (q.amountMaxCenti !== undefined) qb = qb.lte('amount_centi', q.amountMaxCenti);

    /* The PAYMENT's own slip, which is exactly what slip_uploaded reports below.
       2990 filtered this column but then emitted slipUploaded from a fallback to
       the SO header's slip — so ?slipUploaded=false could return rows flagged
       slipUploaded: true. In an audit trail the filter and the flag disagreeing
       is the bug, not a detail. See SO_SLIP_KEY below. */
    if (q.slipUploaded === 'true') qb = qb.not('slip_key', 'is', null);
    if (q.slipUploaded === 'false') qb = qb.is('slip_key', null);

    // Newest money first; created_at breaks ties within a paid_at DAY (paid_at
    // is a date, so same-day payments would otherwise page nondeterministically).
    return qb
      .order('paid_at', { ascending: false })
      .order('created_at', { ascending: false })
      .range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const payments = (data ?? []) as unknown as PaymentRow[];
  if (payments.length === 0) return c.json(emptyPayload(from, to));

  /* Staff NAMES for both uuid columns in ONE batched read — the proven pattern
     from unbilled-deliveries / reports, rather than a nested PostgREST embed:
     mfg_sales_order_payments and mfg_sales_orders each carry TWO FKs to staff,
     so an un-hinted embed is ambiguous. chunkIn bounds the .in() list to <=200
     per request and pages each, so a wide window can neither blow the URL length
     nor lose names to the 1000-row cap. */
  const staffIds = [
    ...new Set(
      payments
        .flatMap((p) => [p.collected_by, p.so?.salesperson_id])
        .filter((x): x is string => !!x),
    ),
  ];
  const nameById = new Map<string, string>();
  if (staffIds.length > 0) {
    const { data: staffRows, error: staffErr } = await chunkIn<{ id: string; name: string | null }>(
      staffIds,
      (batch, pFrom, pTo) => sb.from('staff').select('id, name').in('id', batch).range(pFrom, pTo),
    );
    /* 500, never a partial map. A failed name read must not read as "these staff
       have no name" — an audit row whose collector silently renders blank is a
       row Finance cannot act on, and it would look identical to a genuinely
       unattributed payment. */
    if (staffErr) return c.json({ error: 'load_failed', reason: staffErr.message }, 500);
    for (const s of staffRows) if (s.id && s.name) nameById.set(s.id, s.name);
  }

  const rows: Row[] = payments.map((p) => {
    /* !inner guarantees the header, so `so` is only optional to TypeScript. It is
       still read defensively — but never with `?? 0` on money: local_total_centi
       is `integer DEFAULT 0 NOT NULL`, so a 0 it reports is a REAL zero, not a
       failed read dressed up as one. */
    const so = p.so;
    const paymentSlipKey = p.slip_key;
    return {
      id: p.id,
      so_doc_no: p.so_doc_no,
      paid_at: p.paid_at,
      created_at: p.created_at,
      method: p.method,
      merchant_provider: p.merchant_provider,
      online_type: p.online_type,
      installment_months: p.installment_months,
      approval_code: p.approval_code,
      account_sheet: p.account_sheet,
      note: p.note,
      amount_centi: Number(p.amount_centi),
      is_deposit: p.is_deposit === true,
      slip_key: paymentSlipKey,
      // Reports THIS payment's own proof — the same predicate ?slipUploaded
      // filters on, so the flag and the filter can never disagree.
      slip_uploaded: paymentSlipKey !== null,
      /* SO_SLIP_KEY — the order-level slip, surfaced SEPARATELY rather than
         folded into slip_key. 2990 coalesced the two so a legacy payment could
         still show a slip link; the cost was a payment claiming proof it does not
         have. Keeping the columns apart preserves the link for the UI AND keeps
         "this payment has a slip" an honest answer. */
      so_slip_key: so?.slip_key ?? null,
      customer_name: so?.debtor_name ?? null,
      customer_phone: so?.phone ?? null,
      so_total_centi: so ? Number(so.local_total_centi) : null,
      /* VENUE — the TEXT snapshot on the SO header, not 2990's venues(name)
         join. In Houzs the scm.venues table is EMPTY (the venue master is
         public.project_venues, which the scm supabase client cannot reach — see
         routes/venues.ts) and so-mirror NULLs venue_id on every mirrored SO, so
         the ported join would have returned null for every row. */
      venue: so?.venue ?? null,
      salesperson_id: so?.salesperson_id ?? null,
      salesperson: so?.salesperson_id ? nameById.get(so.salesperson_id) ?? null : null,
      /* COLLECTED_BY — who took the money. 2990's equivalent column was
         `created_by` ("keyed by"), and porting THAT would have shipped a false
         audit claim: every SCM write stamps created_by from c.get('user').id,
         which middleware/auth.ts pins to ONE system staff uuid for every caller.
         So in Houzs created_by answers "the system" for 100% of rows, a
         ?staffId= filter on it would match everything or nothing, and a "Keyed
         by" column would name the same row for every payment ever taken.
         collected_by is the REAL staff uuid (FK -> scm.staff, stamped from the
         SO's salesperson or the caller's own mig-0066 staff row, and settable on
         the manual Finance route), and it is already joined to a name on four
         other payment surfaces. It is the column that answers 2990's question.
         Per-person attribution reads houzsUser + the 0066 bridge, never the
         pinned `user` (#633). */
      collected_by: p.collected_by,
      collected_by_name: p.collected_by ? nameById.get(p.collected_by) ?? null : null,
    };
  });

  return c.json({
    range: { from, to: to ?? null },
    rows,
    count: rows.length,
    // Over the rows RETURNED, so a filtered read never shows a total it is not
    // showing rows for.
    total_amount_centi: rows.reduce((s, r) => s + r.amount_centi, 0),
  });
});

export default paymentAuditLog;
