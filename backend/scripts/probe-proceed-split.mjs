#!/usr/bin/env node
/* THE SPLIT BETWEEN THE TWO PROCESSING-DATE STORAGES, measured. Read-only —
   writes NOTHING, and every statement below is a SELECT.

   WHY. The owner has ruled three times that the Processing Date is ONE thing
   (2026-07-31, 2026-08-13, and again today) and named the scope: frontend,
   backend and database. `scm.mfg_sales_orders.proceeded_at` is the second
   storage that survived, and exactly ONE reachable decision still branches on
   it alone — backend/src/scm/lib/so-stock-allocation.ts:219,
   `orders.filter((o) => !o.proceeded_at)`. Moving that filter onto
   `processing_date` changes the allocation outcome for precisely the orders
   where the two columns DISAGREE about presence, and for nobody else.

   So this measures the disagreement, per company, BY STATUS — because the
   status is what decides whether the flip is invisible bookkeeping or an
   operator watching an order fall out of READY_TO_SHIP.

     A. the 2x2 presence cross-tab (processing_date set? x proceeded_at set?),
        per company, under the allocator's own live lens AND over the whole
        book, so the terminal rows are counted rather than assumed harmless
     B. the same cross-tab broken down BY STATUS — the number the read-only
        phase could not reach
     C. for the both-set class, whether the two AGREE on the calendar day, in
        MALAYSIA time. The 2026-08-13 unification's own post-check compared
        `processing_date <> (proceeded_at AT TIME ZONE 'UTC')::date`
        (scripts/unify-processing-date.mjs:344), which is off by one for any
        stamp landing between 16:00 and 24:00 UTC — i.e. exactly the evening
        MYT stamps. This uses Asia/Kuala_Lumpur.
     D. the flip list as a pure count: which live orders change allocation
        answer, and from what status

   THE LIVE LENS is backend/src/scm/shared/so-terminal-states.ts verbatim, which
   is what so-stock-allocation.ts sends to PostgREST. DRAFT is terminal for
   allocation: it never creates demand.

   PUBLIC REPO — workflow logs are public. This prints COUNTS AND STATUSES ONLY.
   No doc numbers, no customer names, no addresses, no amounts, no dates: a
   count cannot leak the order book, and the order book is the thing an earlier
   phase declined to publish to settle exactly this question.

   COMPANY=2,1 node scripts/probe-proceed-split.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const COMPANIES = (process.env.COMPANY || '2,1')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
if (COMPANIES.length === 0) { console.error('need COMPANY'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const n = (v) => Number(v ?? 0);
const pad = (v, w) => String(v).padStart(w);
const padR = (v, w) => String(v).padEnd(w);

/* Verbatim from backend/src/scm/shared/so-terminal-states.ts. */
const TERMINAL = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];

/* The four presence classes, named the way the decision cares about them. */
const KLASS = {
  'date+stamp': 'both set — every consumer already agrees, flip is a no-op',
  'date only': 'MIRROR — gated today on the retired column, ungates after',
  'stamp only': 'DANGEROUS — allocating today, gated after',
  neither: 'gated before and after',
};

let hardFail = false;

async function main() {
  /* Pre-flight: the column must still exist, or every count below is a lie
     about the wrong schema. A probe that measures nothing must say so loudly
     rather than print four zeroes and read as "clean". */
  const cols = await sql`
    SELECT attname FROM pg_attribute
     WHERE attrelid = 'scm.mfg_sales_orders'::regclass
       AND attname IN ('processing_date', 'proceeded_at')
       AND attnum > 0 AND NOT attisdropped`;
  const have = new Set(cols.map((r) => r.attname));
  note(`[0] columns present on scm.mfg_sales_orders: processing_date=${have.has('processing_date')} proceeded_at=${have.has('proceeded_at')}`);
  if (!have.has('processing_date')) {
    console.error('FATAL: scm.mfg_sales_orders.processing_date does not exist — wrong DB or the rename never landed');
    process.exitCode = 2; return;
  }
  if (!have.has('proceeded_at')) {
    note('proceeded_at is already gone — the split cannot exist. Nothing further to measure.');
    return;
  }

  for (const company of COMPANIES) {
    note('');
    note(`═══ COMPANY ${company} ═══`);

    /* ── A. presence cross-tab, whole book and live lens ─────────────────── */
    const [tab] = await sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status <> ALL(${TERMINAL}))::int AS live,
        count(*) FILTER (WHERE processing_date IS NOT NULL AND proceeded_at IS NOT NULL)::int AS both_all,
        count(*) FILTER (WHERE processing_date IS NOT NULL AND proceeded_at IS NULL)::int     AS date_only_all,
        count(*) FILTER (WHERE processing_date IS NULL     AND proceeded_at IS NOT NULL)::int AS stamp_only_all,
        count(*) FILTER (WHERE processing_date IS NULL     AND proceeded_at IS NULL)::int     AS neither_all,
        count(*) FILTER (WHERE status <> ALL(${TERMINAL}) AND processing_date IS NOT NULL AND proceeded_at IS NOT NULL)::int AS both_live,
        count(*) FILTER (WHERE status <> ALL(${TERMINAL}) AND processing_date IS NOT NULL AND proceeded_at IS NULL)::int     AS date_only_live,
        count(*) FILTER (WHERE status <> ALL(${TERMINAL}) AND processing_date IS NULL     AND proceeded_at IS NOT NULL)::int AS stamp_only_live,
        count(*) FILTER (WHERE status <> ALL(${TERMINAL}) AND processing_date IS NULL     AND proceeded_at IS NULL)::int     AS neither_live
      FROM scm.mfg_sales_orders
      WHERE company_id = ${company}`;

    note(`[A] company ${company}: ${n(tab.total)} orders total, ${n(tab.live)} live (allocator lens)`);
    note(`    ${padR('class', 12)} ${pad('live', 6)} ${pad('all', 6)}   meaning`);
    const rows = [
      ['date+stamp', tab.both_live, tab.both_all],
      ['date only', tab.date_only_live, tab.date_only_all],
      ['stamp only', tab.stamp_only_live, tab.stamp_only_all],
      ['neither', tab.neither_live, tab.neither_all],
    ];
    for (const [k, liveC, allC] of rows) {
      note(`    ${padR(k, 12)} ${pad(n(liveC), 6)} ${pad(n(allC), 6)}   ${KLASS[k]}`);
    }

    /* ── B. the same classes BY STATUS — the decision-relevant gap ────────── */
    const byStatus = await sql`
      SELECT
        coalesce(status, '(null)') AS status,
        (status <> ALL(${TERMINAL})) AS is_live,
        CASE
          WHEN processing_date IS NOT NULL AND proceeded_at IS NOT NULL THEN 'date+stamp'
          WHEN processing_date IS NOT NULL AND proceeded_at IS NULL     THEN 'date only'
          WHEN processing_date IS NULL     AND proceeded_at IS NOT NULL THEN 'stamp only'
          ELSE 'neither'
        END AS klass,
        count(*)::int AS cnt
      FROM scm.mfg_sales_orders
      WHERE company_id = ${company}
      GROUP BY 1, 2, 3
      ORDER BY 3, 1`;
    note(`[B] company ${company}: presence class x status (${byStatus.length} cells)`);
    note(`    ${padR('class', 12)} ${padR('status', 16)} ${pad('n', 6)}  live?`);
    for (const r of byStatus) {
      note(`    ${padR(r.klass, 12)} ${padR(r.status, 16)} ${pad(n(r.cnt), 6)}  ${r.is_live ? 'LIVE' : 'terminal'}`);
    }

    /* ── C. both-set: do the two AGREE on the MYT calendar day? ───────────── */
    const [agree] = await sql`
      SELECT
        count(*)::int AS both,
        count(*) FILTER (
          WHERE processing_date::date
              = (proceeded_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date
        )::int AS same_day_myt,
        count(*) FILTER (
          WHERE processing_date::date
              = (proceeded_at AT TIME ZONE 'UTC')::date
        )::int AS same_day_utc
      FROM scm.mfg_sales_orders
      WHERE company_id = ${company}
        AND processing_date IS NOT NULL AND proceeded_at IS NOT NULL`;
    const both = n(agree.both);
    note(`[C] company ${company}: of ${both} both-set orders, ${n(agree.same_day_myt)} agree on the MYT calendar day (${both - n(agree.same_day_myt)} differ); the UTC comparison the 2026-08-13 post-check used would have said ${n(agree.same_day_utc)}`);
    if (both > 0 && n(agree.same_day_myt) !== both) {
      note(`    NOTE: day disagreement affects NO gate today — no consumer compares the two columns. It is printed because the 2026-08-13 verification claimed agreement using a UTC cast.`);
    }

    /* ── D. the flip, as a count, by status ───────────────────────────────── */
    const flips = await sql`
      SELECT coalesce(status, '(null)') AS status, count(*)::int AS cnt
      FROM scm.mfg_sales_orders
      WHERE company_id = ${company}
        AND status <> ALL(${TERMINAL})
        AND processing_date IS NULL AND proceeded_at IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC, 1`;
    const flipTotal = flips.reduce((a, r) => a + n(r.cnt), 0);
    note(`[D] company ${company}: ${flipTotal} live orders would flip UNGATED -> GATED (lines forced PENDING on the next recompute)`);
    for (const r of flips) {
      const visible = r.status === 'READY_TO_SHIP' ? '  <-- VISIBLE REGRESSION: drops back to CONFIRMED' : '';
      note(`    ${padR(r.status, 16)} ${pad(n(r.cnt), 6)}${visible}`);
    }
    if (flipTotal > 0) hardFail = true;

    const unflips = await sql`
      SELECT coalesce(status, '(null)') AS status, count(*)::int AS cnt
      FROM scm.mfg_sales_orders
      WHERE company_id = ${company}
        AND status <> ALL(${TERMINAL})
        AND processing_date IS NOT NULL AND proceeded_at IS NULL
      GROUP BY 1 ORDER BY 2 DESC, 1`;
    const unflipTotal = unflips.reduce((a, r) => a + n(r.cnt), 0);
    note(`[D] company ${company}: ${unflipTotal} live orders would flip GATED -> UNGATED (a correction: the operator already sees a Processing Date on them)`);
    for (const r of unflips) note(`    ${padR(r.status, 16)} ${pad(n(r.cnt), 6)}`);

    /* ── E. the leak's other half: does anything still WRITE a stamp with no
       date? Newest stamp-only row, as an AGE IN DAYS (never a date). If the
       newest is old, the population is a static backlog; if it is hours old,
       something is still producing it and repairing once will not hold. ──── */
    const [age] = await sql`
      SELECT
        count(*)::int AS n,
        max(proceeded_at) IS NOT NULL AS has_max,
        coalesce(extract(epoch FROM (now() - max(proceeded_at))) / 86400.0, -1)::numeric(10,2) AS newest_age_days,
        coalesce(extract(epoch FROM (now() - min(proceeded_at))) / 86400.0, -1)::numeric(10,2) AS oldest_age_days
      FROM scm.mfg_sales_orders
      WHERE company_id = ${company}
        AND processing_date IS NULL AND proceeded_at IS NOT NULL`;
    if (n(age.n) > 0) {
      note(`[E] company ${company}: stamp-only rows (any status) span ${age.oldest_age_days} down to ${age.newest_age_days} days old. Newest under ~5 days means the population is REGENERATING, not a frozen backlog.`);
    } else {
      note(`[E] company ${company}: no stamp-only rows at all.`);
    }
  }

  note('');
  if (hardFail) {
    note('VERDICT: at least one company has live orders that would change allocation answer. The gate flip is NOT a no-op — repair or rule on them first.');
  } else {
    note('VERDICT: no live order changes allocation answer in either company. Flipping so-stock-allocation.ts onto processing_date is a no-op on today\'s data.');
  }
}

main()
  .then(() => sql.end())
  .catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
