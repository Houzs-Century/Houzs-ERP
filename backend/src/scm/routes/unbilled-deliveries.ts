// ----------------------------------------------------------------------------
// /unbilled-deliveries — goods that LEFT THE WAREHOUSE and were never charged
// for, aged. Read-only: this route never writes.
//
// WHY THIS EXISTS WHEN /outstanding/do ALREADY SAYS "DOs not yet invoiced".
// It doesn't say that — it says "nobody clicked INVOICED on this DO". The view
// (scm.v_do_outstanding, mig 0084) is a HEADER-STATUS FLAG:
//     is_outstanding := status NOT IN ('INVOICED','CANCELLED')
// with no money column at all — which is why outstanding.ts's SUMMARY_AGG maps
// `do: { amtCol: null }` and the DO tab can only ever report a COUNT. It cannot
// show what the gap is worth, and three things make its flag the wrong question:
//
//   1. NOTHING IN THE CODEBASE EVER WRITES delivery_orders.status='INVOICED'.
//      Creating a Sales Invoice from a DO does not advance the DO: sales-invoices.ts
//      only READS the DO header (`.select('id, status')`), it never updates it. The
//      only writers of DO status are the operator-driven PATCH /:id/status and the
//      Delivery-Planning board. So the flag measures whether someone REMEMBERED to
//      click a status — not whether we billed. It is unreliable in BOTH directions:
//      a fully-billed DO left at DELIVERED looks like leakage (false positive), and
//      a DO clicked to INVOICED with one line billed out of five looks clean (false
//      negative — the expensive direction).
//   2. IT IS HEADER-LEVEL, so a PARTLY invoiced DO is all-or-nothing. Partial
//      invoicing is exactly where money hides.
//   3. IT DOES NOT AGE. Steady-state un-invoiced runs 1–3%/month; the CURRENT month
//      runs ~67% and that is normal billing lag, not leakage. An un-aged list is
//      dominated by rows nobody should act on, so nobody reads it twice.
//
// This report answers the money question instead, from the LINE ledger.
//
// ── "DELIVERED" = THE STOCK ACTUALLY LEFT ────────────────────────────────────
// Not a new opinion — the SAME predicate that already moved the stock.
// delivery-orders-mfg.ts declares SHIPPED_STATES ("goods have left our hands, so
// stock has been deducted"; the first transition into any of them fires the
// inventory OUT), DO_STOCK_OUT_STATUSES ("statuses in which the inventory OUT has
// already been written") and their complement DO_PRESHIP_STATUSES = {DRAFT,
// LOADED} ("no stock has left our hands yet"). If the inventory OUT was written,
// the goods are gone and someone owes us for them — so THAT is the definition
// this report uses, and it and the stock ledger cannot disagree about what "left"
// means. A LOADED DO is still on the lorry: billing it would be the bug, not the
// finding. CANCELLED delivered nothing. See NOT_SHIPPED_STATES below for why the
// predicate is written as the complement rather than as a positive list.
//
// NOTE the deliberate asymmetry: the status 'INVOICED' COUNTS AS SHIPPED here.
// This report reads the header status ONLY as evidence the goods SHIPPED, and
// NEVER as evidence they were BILLED. Billing is answered from the line links
// below — which is the whole point of (1).
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { doLineRemaining } from '../lib/do-line-remaining';
import { todayMyt } from '../lib/my-time';

export const unbilledDeliveries = new Hono<{ Bindings: Env; Variables: Variables }>();
unbilledDeliveries.use('*', supabaseAuth);

/* NOT-SHIPPED states — the states we EXCLUDE, expressed as the complement.
   This is deliberately a NEGATIVE filter, and the reason matters:
     • It is exactly DO_PRESHIP_STATUSES {DRAFT, LOADED} ("no stock has left our
       hands yet" — delivery-orders-mfg.ts) plus CANCELLED (delivered nothing).
       Every other state means the inventory OUT was written, i.e. the goods went.
     • status is the PG enum scm.do_status, and a positive `.in()` list naming a
       value the enum does NOT have makes Postgres throw ("invalid input value for
       enum do_status") — a 500, not an empty result. The tree's enum is
       {DRAFT, LOADED, DISPATCHED, IN_TRANSIT, SIGNED, DELIVERED, INVOICED,
       CANCELLED} (base schema + mig 0040 adds DRAFT). This comment used to add
       that delivery-orders-mfg.ts "ALSO carries 'COMPLETED'", and that the tree
       therefore could not settle whether prod's enum had it. PROD SETTLED IT on
       2026-08-17: `?status=delivered` returned 500 `invalid input value for enum
       do_status: "COMPLETED"` in both tenants, so the enum is exactly the eight
       above and COMPLETED has been removed from the shared declaration. This
       report was the one place that guessed the safe way and never broke.
     • The fail direction is deliberate. An unknown status surfaces a row he can
       dismiss; a positive list would have hidden that row's money silently —
       which is the exact failure this whole report exists to catch. */
const NOT_SHIPPED_STATES = '("DRAFT","LOADED","CANCELLED")';

/* Ageing buckets, days since do_date. Same shape + lookup as the inventory
   ageing report (routes/inventory.ts BUCKETS) so the two read alike.
   Tuned for BILLING lag, not stock age: 0–30 is the normal billing queue (the
   current month legitimately runs ~2/3 un-invoiced and is NOT leakage), so the
   resolution is deliberately coarse at the near end and the tail is split at
   365 — that is where the real money sits (111 DOs / RM 714,919 in the owner's
   AutoCount). `max` is INCLUSIVE; the last bucket catches everything else. */
const BUCKETS = [
  { key: '0-30',    label: '0–30 days (normal billing lag)', max: 30 },
  { key: '31-60',   label: '31–60 days',                     max: 60 },
  { key: '61-90',   label: '61–90 days',                     max: 90 },
  { key: '91-180',  label: '91–180 days',                    max: 180 },
  { key: '181-365', label: '181–365 days',                   max: 365 },
  { key: '365+',    label: 'Over 12 months',                 max: Infinity },
] as const;

const bucketOf = (ageDays: number): (typeof BUCKETS)[number] => {
  const b = BUCKETS.find((x) => ageDays <= x.max);
  return b ?? BUCKETS[BUCKETS.length - 1]!;
};

/* Whole days between two MY calendar dates (`YYYY-MM-DD`). Both sides are MY
   wall-clock days — do_date is a DATE column stamped via todayMyt(), and the
   "today" we compare against is todayMyt() too — so parsing both as UTC midnight
   and differencing is exact, with no timezone skew. A future-dated do_date
   (back-office data entry) clamps to 0 rather than reporting a negative age. */
const ageDaysBetween = (fromYmd: string, toYmd: string): number => {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
};

/* Money value of `n` units of a DO line.
   A DO line's total is `max(0, qty*unit_price − discount)` — buildItemRow in
   delivery-orders-mfg.ts. DO lines carry NO tax column (unlike SI lines), so
   there is no tax term to pro-rate. The line discount is a whole-line amount, so
   a PARTIAL quantity takes its pro-rata share of it. When n == delivered this is
   exactly the stored line_total_centi, so a fully-unbilled line reports the
   document's own number and nothing is invented. */
const valueOfUnits = (
  n: number,
  delivered: number,
  unitPriceCenti: number,
  discountCenti: number,
): number => {
  if (n <= 0 || delivered <= 0) return 0;
  const share = Math.round((discountCenti * n) / delivered);
  return Math.max(0, n * unitPriceCenti - share);
};

type Row = {
  delivery_order_id: string;
  do_number: string;
  do_date: string;
  age_days: number;
  bucket: string;
  bucket_label: string;
  status: string;
  so_doc_no: string | null;
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  salesperson: string | null;
  delivered_centi: number;
  invoiced_centi: number;
  returned_centi: number;
  unbilled_centi: number;
  lines_total: number;
  lines_pending: number;
  partly_invoiced: boolean;
};

/**
 * GET /unbilled-deliveries — one row per Delivery Order that has shipped and
 * still has un-invoiced value, oldest first.
 *
 * Query params (all optional):
 *   ?minAgeDays=31   only rows at least this old (default 0 = everything)
 *   ?bucket=365+     only one ageing bucket (key from BUCKETS)
 *   ?debtorCode=     one customer
 *   ?from= / ?to=    do_date range, YYYY-MM-DD, inclusive
 *
 * Returns { as_of, rows, buckets, totals }. `buckets` + `totals` are computed
 * over the ROWS RETURNED, so they always reconcile with the list on screen.
 */
unbilledDeliveries.get('/', async (c) => {
  const sb = c.get('supabase');

  const minAgeDays = Math.max(0, Number(c.req.query('minAgeDays') ?? 0) || 0);
  const bucketFilter = c.req.query('bucket');
  const debtorCode = c.req.query('debtorCode');
  const from = c.req.query('from');
  const to = c.req.query('to');

  /* Row-level visibility — the SAME rule and source of truth as the DO list
     handler (delivery-orders-mfg.ts `.in('salesperson_id', scopeIds)`) and the
     DO detail listing in reports.ts. Without it a scoped rep would read every
     other rep's delivered value through this report while being correctly
     blocked on the module page. Resolved ONCE, outside the pager, so every page
     of a wide range uses one scope.
     NOTE: must pass the REAL Houzs integer user id (houzsUser) — user.id here is
     the bridge's pinned system staff uuid, and feeding that to the scope lookup
     is the documented non-admin 500. */
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  // Shipped DO headers. paginateAll — PostgREST caps every response at 1000 rows
  // and DROPS the rest with no error, and the whole point of this report is a
  // multi-year tail (the owner's book has 1,452 un-invoiced DOs), so a single
  // .select() would silently report the first 1000 and hide the oldest money.
  const { data: doHeaders, error } = await paginateAll<Record<string, unknown>>((pFrom, pTo) => {
    let q = sb
      .from('delivery_orders')
      .select('id, do_number, so_doc_no, debtor_code, debtor_name, phone, do_date, status, salesperson_id, agent')
      // Everything that ISN'T pre-ship or cancelled — see NOT_SHIPPED_STATES.
      // Same shape as resolveCandidateDoIds' guard in lib/do-line-remaining,
      // which excludes {CANCELLED, DRAFT}; this one also drops LOADED, because a
      // LOADED DO is still on the lorry and billing it would be the bug.
      .not('status', 'in', NOT_SHIPPED_STATES);
    if (debtorCode) q = q.eq('debtor_code', debtorCode);
    if (from) q = q.gte('do_date', from);
    if (to) q = q.lte('do_date', to);
    /* minAgeDays pushed DOWN into SQL rather than filtered in JS after the line
       math: `age >= N` ⟺ `do_date <= today − N`, and todayMyt(-N) is the same
       MY-calendar helper the age column is computed from below, so the two agree
       by construction. Worth doing — the line ledger is the expensive part of
       this handler, so bounding the candidate set HERE (rather than reading every
       shipped DO's lines and then discarding them) is what keeps a targeted read
       like ?minAgeDays=366 cheap. */
    if (minAgeDays > 0) q = q.lte('do_date', todayMyt(-minAgeDays));
    /* MULTI-COMPANY ISOLATION. The SCM client is service-role, so RLS is
       bypassed and this app-layer predicate is the ONLY boundary. scopeToCompany
       is three-state (see lib/companyScope): unresolved → no predicate (degrade,
       single-company Houzs unchanged); granted-no-active-company → `.in(...,[])`
       → matches nothing; otherwise → the active company. Everything downstream
       is keyed off the ids this query returns, so scoping here scopes the whole
       report. */
    q = scopeToCompany(q, c);
    if (scopeIds) q = q.in('salesperson_id', scopeIds);
    return q.order('do_date', { ascending: true }).range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  type Header = {
    id: string; do_number: string; so_doc_no: string | null;
    debtor_code: string | null; debtor_name: string | null; phone: string | null;
    do_date: string; status: string; salesperson_id: string | null; agent: string | null;
  };
  const headers = (doHeaders ?? []) as unknown as Header[];
  if (headers.length === 0) {
    return c.json({ as_of: todayMyt(), rows: [], buckets: emptyBuckets(), totals: emptyTotals() });
  }

  /* THE LINE LEDGER. doLineRemaining is the single source of truth already used
     by the DO→SI and DO→DR pickers and by the SI write-path guards:
         remaining = delivered − invoiced − returned
     per DO line, derived LIVE from the rows (no stored counter to drift), where
     `invoiced` counts sales_invoice_items linked by do_item_id to a NON-cancelled
     invoice and `returned` counts delivery_return_items likewise. Using it here
     means "un-invoiced" in this report is the SAME number the SI picker will
     offer him when he acts on a row — the report cannot promise money the picker
     then refuses to bill.
     It also gives three exclusions for free, as VALUE rather than as guesswork —
     see the unbilled_centi > 0 filter below.

     COST — read this before widening the default. doLineRemaining is built for a
     PICKER (a handful of DOs): it chunks every id list at 200 and issues a
     request per chunk, so it costs roughly one subrequest per 200 DOs plus one
     per 200 DO LINES, twice over (SI links + DR links). Feeding it every shipped
     DO is therefore linear in the whole book, and Workers cap a request at 1000
     subrequests. That is comfortable at today's row counts and is the reason
     minAgeDays is pushed into SQL above — a targeted read stays small. If this
     ever starts timing out, the fix is to make the ledger read set-based (one
     paged sweep per table, joined in memory), NOT to re-implement the
     remaining = delivered − invoiced − returned formula here: a second copy of
     that formula is how the report and the SI picker would start disagreeing
     about what is billable, which is worse than a slow report. */
  const ledger = await doLineRemaining(sb, headers.map((h) => h.id));
  /* REFUSE TO RENDER rather than report a clean book. Every row of this report
     is gated on `a.unbilled > 0` below, so an unreadable ledger drops EVERY row
     and the answer becomes "nothing is outstanding" — on the one screen whose
     entire job is to find money that was delivered and never billed. The
     headers read above already answers a failure this way; the ledger is the
     more expensive half of the same question and gets the same answer. */
  if (!ledger.ok) return c.json({ error: 'load_failed', reason: ledger.reason }, 500);
  const remainingByItem = ledger.lines;

  // Fold the line ledger up to one row per DO.
  type Agg = { delivered: number; invoiced: number; returned: number; unbilled: number; lines: number; pending: number };
  const aggByDo = new Map<string, Agg>();
  for (const line of remainingByItem.values()) {
    const a = aggByDo.get(line.deliveryOrderId)
      ?? { delivered: 0, invoiced: 0, returned: 0, unbilled: 0, lines: 0, pending: 0 };
    const val = (n: number) => valueOfUnits(n, line.delivered, line.unitPriceCenti, line.discountCenti);
    a.delivered += val(line.delivered);
    a.invoiced += val(line.invoiced);
    a.returned += val(line.returned);
    a.unbilled += val(line.remaining);
    a.lines += 1;
    if (line.remaining > 0) a.pending += 1;
    aggByDo.set(line.deliveryOrderId, a);
  }

  const asOf = todayMyt();
  const rows: Row[] = [];
  for (const h of headers) {
    const a = aggByDo.get(h.id);
    /* EXCLUSIONS — all three fall out of `unbilled_centi > 0`, none is a
       hand-maintained flag list that could rot:
         • FULLY INVOICED — every line's invoiced qty consumed its delivered qty,
           so remaining = 0. (This is also how a DO whose header status was never
           clicked to INVOICED stays out: we bill from the links, not the click.)
         • RETURNED — delivery_return_items linked by do_item_id subtract from the
           SAME pool ("invoicing and returning COMPETE for the same Pending pool"
           — lib/do-line-remaining). A DO that came back is not money owed. A
           PARTIAL return correctly leaves only the un-returned part billable, so
           we neither cry wolf on the whole DO nor lose the real remainder.
         • ZERO-VALUE — a free replacement / warranty swap / sample prices its
           lines at 0, so its unbilled value is 0. There is nothing to collect, so
           it is not a finding. (222 of the owner's 1,452 are this.)
       Note this is a VALUE test, not a QTY test: a line can have remaining units
       worth nothing, and that is not leakage either.
       CONSIGNMENT needs no test at all — consignment DOs are a different TABLE
       (scm.consignment_delivery_orders, mig 0153, CN- numbering; see
       routes/consignment-notes.ts). This report only ever reads delivery_orders,
       so a consignment note can never reach it. */
    if (!a || a.unbilled <= 0) continue;

    // NOTE: no minAgeDays test here — it is already applied as a do_date bound in
    // SQL above. One rule, one place; re-testing it here would be a second copy
    // that could drift from the pushdown.
    const ageDays = ageDaysBetween(h.do_date, asOf);
    const b = bucketOf(ageDays);
    if (bucketFilter && b.key !== bucketFilter) continue;

    rows.push({
      delivery_order_id: h.id,
      do_number: h.do_number,
      do_date: h.do_date,
      age_days: ageDays,
      bucket: b.key,
      bucket_label: b.label,
      status: h.status,
      so_doc_no: h.so_doc_no,
      debtor_code: h.debtor_code,
      debtor_name: h.debtor_name,
      phone: h.phone,
      // Filled from the staff batch below.
      salesperson: h.agent,
      delivered_centi: a.delivered,
      invoiced_centi: a.invoiced,
      returned_centi: a.returned,
      unbilled_centi: a.unbilled,
      lines_total: a.lines,
      lines_pending: a.pending,
      /* The expensive case: SOME of this DO was billed and the rest was not. A
         header-status report can never see these — the DO reads INVOICED. */
      partly_invoiced: a.invoiced > 0 && a.unbilled > 0,
    });
  }

  /* Salesperson name — every row must tell him who to call. salesperson_id is an
     scm.staff uuid (the mig-0066 picker vocabulary); resolve to a name in ONE
     batched query. chunkIn bounds the .in() list to ≤200 per request and pages
     each, so a wide report can neither blow the URL length nor lose names to the
     1000-row cap. Falls back to the DO's own `agent` text (already on the row)
     when the staff row is missing, so the column is never blank for a legacy DO. */
  const staffIds = [...new Set(
    headers.filter((h) => h.salesperson_id).map((h) => h.salesperson_id as string),
  )];
  if (staffIds.length > 0) {
    const { data: staffRows, error: staffErr } = await chunkIn<{ id: string; name: string | null }>(
      staffIds,
      (batch, pFrom, pTo) => sb.from('staff').select('id, name').in('id', batch).range(pFrom, pTo),
    );
    if (staffErr) return c.json({ error: 'load_failed', reason: staffErr.message }, 500);
    const nameById = new Map<string, string>();
    for (const s of staffRows) if (s.id && s.name) nameById.set(s.id, s.name);
    const spByDo = new Map(headers.map((h) => [h.id, h.salesperson_id]));
    for (const r of rows) {
      const sid = spByDo.get(r.delivery_order_id);
      r.salesperson = (sid ? nameById.get(sid) : null) ?? r.salesperson ?? null;
    }
  }

  // Oldest money first — the tail is the finding, the current month is the noise.
  rows.sort((x, y) => y.age_days - x.age_days || y.unbilled_centi - x.unbilled_centi);

  // Buckets + totals over the ROWS RETURNED, so the summary always reconciles
  // with the list (a filtered read never shows a total it isn't showing rows for).
  const buckets = emptyBuckets();
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const r of rows) {
    const b = byKey.get(r.bucket);
    if (b) { b.rows += 1; b.unbilled_centi += r.unbilled_centi; }
  }
  const totals = {
    rows: rows.length,
    unbilled_centi: rows.reduce((s, r) => s + r.unbilled_centi, 0),
    /* The headline. Steady-state un-invoiced is 1–3%/month and the current month
       is billing lag — so the number that means something is the tail that never
       got billed at all. Surfaced separately so a caller (or a KPI card) doesn't
       have to re-derive it and get the boundary wrong. */
    over_365: {
      rows: rows.filter((r) => r.age_days > 365).length,
      unbilled_centi: rows.filter((r) => r.age_days > 365).reduce((s, r) => s + r.unbilled_centi, 0),
    },
    /* Partly-invoiced value, called out because it is invisible to any
       header-status report and is the likeliest place for silent leakage. */
    partly_invoiced: {
      rows: rows.filter((r) => r.partly_invoiced).length,
      unbilled_centi: rows.filter((r) => r.partly_invoiced).reduce((s, r) => s + r.unbilled_centi, 0),
    },
  };

  return c.json({ as_of: asOf, rows, buckets, totals });
});

function emptyBuckets(): Array<{ key: string; label: string; rows: number; unbilled_centi: number }> {
  return BUCKETS.map((b) => ({ key: b.key, label: b.label, rows: 0, unbilled_centi: 0 }));
}

function emptyTotals() {
  return {
    rows: 0,
    unbilled_centi: 0,
    over_365: { rows: 0, unbilled_centi: 0 },
    partly_invoiced: { rows: 0, unbilled_centi: 0 },
  };
}
