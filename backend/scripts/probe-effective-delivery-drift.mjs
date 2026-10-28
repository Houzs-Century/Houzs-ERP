#!/usr/bin/env node
/* WHOSE PRIORITY MOVES when MRP and the stock allocator start planning on the
   EFFECTIVE (amended) delivery date instead of the customer's ORIGINAL one.
   Read-only: every statement is a SELECT. No transaction, no DDL, no writes.

   THE SPLIT BEING MEASURED. `customer_delivery_date` is the customer's original
   promise and is never overwritten (migration 0053, owner rule). A reschedule
   writes `amended_delivery_date`. The delivery board, PO coverage, the delivery
   messages and the /inventory reservations screen all read
   `amended_delivery_date ?? customer_delivery_date`; MRP
   (routes/mrp.ts:999-1000, :1196-1197) and the stock allocator
   (lib/so-stock-allocation.ts:198, :496-497, :660-661) read
   `customer_delivery_date` alone. Two screens, two answers for one order.

   AND THE LINE MIRROR IS THE HALF THAT IS EASY TO MISS.
   `mfg_sales_order_items.line_delivery_date` is a MIRROR of the header date
   whenever `line_delivery_date_overridden = false` (mig 0172's
   `apply_so_header_followers` writes exactly that pair). MRP reads
   `line_delivery_date ?? so.customer_delivery_date`, so on a rescheduled order
   the mirror still holds the ORIGINAL date and hides the amendment even from a
   reader that consults the header second. Section C counts those lines: they are
   the ones a header-only fix would silently fail to move.

   WHAT THE NUMBERS DECIDE. Making the effective date the one answer re-ranks
   greedy allocation (both engines sort earliest-delivery-first), so it changes
   WHICH order gets scarce stock and WHAT gets ordered first. That is a business
   consequence, not a refactor, and it is the owner's call whether the size of
   the move is acceptable. This prints the size.

   Both companies in one run — a one-company answer to a two-company question is
   how a partial measurement gets quoted as the whole picture.

   Counts, day-deltas and statuses only: no customer names, no doc numbers, no
   money. The repo and its Action logs are public.

   RE-RUN: idempotent. DATABASE_URL=... node scripts/probe-effective-delivery-drift.mjs
*/
import postgres from 'postgres';
import { SO_TERMINAL_STATES } from './lib/so-terminal-states.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const TERMINAL = [...SO_TERMINAL_STATES];

let failures = 0;
const say = (s = '') => console.log(s);
const pad = (v, n) => String(v).padStart(n);

async function section(title, fn) {
  say(`\n${title}`);
  say('-'.repeat(title.length));
  try { await fn(); } catch (e) {
    failures += 1;
    say(`  FAIL ${e.message}`);
  }
}

async function main() {
  say('probe-effective-delivery-drift — read-only');
  say(`as of ${new Date().toISOString()}`);
  say(`live = status NOT IN (${TERMINAL.join(', ')})`);

  await section('A. Live SO headers: does the amended date disagree with the original?', async () => {
    const rows = await sql`
      SELECT company_id,
             count(*)::int                                                              AS live_headers,
             count(*) FILTER (WHERE amended_delivery_date IS NOT NULL)::int             AS amended_set,
             count(*) FILTER (WHERE amended_delivery_date IS NOT NULL
                                AND customer_delivery_date IS NOT NULL
                                AND amended_delivery_date <> customer_delivery_date)::int AS differs,
             count(*) FILTER (WHERE amended_delivery_date IS NOT NULL
                                AND customer_delivery_date IS NULL)::int                AS amended_only,
             count(*) FILTER (WHERE amended_delivery_date IS NOT NULL
                                AND customer_delivery_date IS NOT NULL
                                AND amended_delivery_date = customer_delivery_date)::int AS same
      FROM scm.mfg_sales_orders
      WHERE status <> ALL(${TERMINAL})
      GROUP BY company_id ORDER BY company_id`;
    say('  company  live  amended_set  DIFFERS  amended_only(orig NULL)  same');
    for (const r of rows) {
      say(`  ${pad(r.company_id, 7)}  ${pad(r.live_headers, 4)}  ${pad(r.amended_set, 11)}  ${pad(r.differs, 7)}  ${pad(r.amended_only, 23)}  ${pad(r.same, 4)}`);
    }
    say('');
    say('  DIFFERS       = priority moves (both dates present, they disagree).');
    say('  amended_only  = MRP sees NO date today (undated, sorts last / hidden);');
    say('                  under the fix it becomes a dated, ranked line.');
  });

  await section('B. How far does it move? amended − original, in days', async () => {
    const rows = await sql`
      SELECT company_id,
             count(*)::int                                          AS n,
             count(*) FILTER (WHERE d < 0)::int                     AS earlier,
             count(*) FILTER (WHERE d > 0)::int                     AS later,
             min(d)::int                                            AS min_days,
             max(d)::int                                            AS max_days,
             round(avg(abs(d)))::int                                AS avg_abs,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY abs(d))::int AS median_abs,
             count(*) FILTER (WHERE abs(d) <= 7)::int               AS within_7d,
             count(*) FILTER (WHERE abs(d) > 7 AND abs(d) <= 30)::int AS d8_30,
             count(*) FILTER (WHERE abs(d) > 30)::int               AS over_30d
      FROM (
        SELECT company_id, (amended_delivery_date - customer_delivery_date) AS d
        FROM scm.mfg_sales_orders
        WHERE status <> ALL(${TERMINAL})
          AND amended_delivery_date IS NOT NULL
          AND customer_delivery_date IS NOT NULL
          AND amended_delivery_date <> customer_delivery_date
      ) t
      GROUP BY company_id ORDER BY company_id`;
    if (rows.length === 0) { say('  (no live header has two disagreeing dates)'); return; }
    say('  company    n  earlier  later   min   max  avg|d|  med|d|  <=7d  8-30d  >30d');
    for (const r of rows) {
      say(`  ${pad(r.company_id, 7)} ${pad(r.n, 4)}  ${pad(r.earlier, 7)}  ${pad(r.later, 5)} ${pad(r.min_days, 5)} ${pad(r.max_days, 5)}  ${pad(r.avg_abs, 6)}  ${pad(r.median_abs, 6)}  ${pad(r.within_7d, 4)}  ${pad(r.d8_30, 5)}  ${pad(r.over_30d, 4)}`);
    }
    say('');
    say('  earlier = amended is BEFORE the original → that order gains priority.');
    say('  later   = amended is AFTER  the original → that order loses priority.');
  });

  await section('C. The line mirror — how many demand lines still carry the old date', async () => {
    const rows = await sql`
      SELECT h.company_id,
             count(*)::int                                                          AS live_lines_on_moved_orders,
             count(*) FILTER (WHERE i.line_delivery_date_overridden IS NOT TRUE)::int AS mirror_lines,
             count(*) FILTER (WHERE i.line_delivery_date_overridden IS TRUE)::int   AS overridden_lines,
             count(*) FILTER (WHERE i.line_delivery_date_overridden IS NOT TRUE
                                AND i.line_delivery_date IS NOT NULL
                                AND i.line_delivery_date <> h.amended_delivery_date)::int AS mirror_holds_stale_date,
             count(DISTINCT i.doc_no)::int                                          AS orders
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.status <> ALL(${TERMINAL})
        AND i.cancelled = false
        AND i.qty > 0
        AND h.amended_delivery_date IS NOT NULL
        AND (h.customer_delivery_date IS NULL OR h.amended_delivery_date <> h.customer_delivery_date)
      GROUP BY h.company_id ORDER BY h.company_id`;
    if (rows.length === 0) { say('  (no live line sits on a moved order)'); return; }
    say('  company  orders  live_lines  mirror  overridden  mirror_holds_STALE_date');
    for (const r of rows) {
      say(`  ${pad(r.company_id, 7)}  ${pad(r.orders, 6)}  ${pad(r.live_lines_on_moved_orders, 10)}  ${pad(r.mirror_lines, 6)}  ${pad(r.overridden_lines, 10)}  ${pad(r.mirror_holds_stale_date, 23)}`);
    }
    say('');
    say('  mirror_holds_STALE_date = lines MRP reads first and that still say the');
    say('  original date. A header-only fix would not move these at all.');
  });

  await section('D. Sanity: is the amended date ever the ONLY date on a live order?', async () => {
    const rows = await sql`
      SELECT company_id, status, count(*)::int AS n
      FROM scm.mfg_sales_orders
      WHERE status <> ALL(${TERMINAL})
        AND amended_delivery_date IS NOT NULL
        AND customer_delivery_date IS NULL
      GROUP BY company_id, status ORDER BY company_id, status`;
    if (rows.length === 0) { say('  none — every amended live order also carries its original date.'); return; }
    for (const r of rows) say(`  company=${r.company_id}  status=${r.status}  n=${r.n}`);
    say('');
    say('  These are pure GAINS for MRP: demand it currently cannot see a date for.');
  });

  await section('E. Live orders whose effective date is already PAST (context only)', async () => {
    const rows = await sql`
      SELECT company_id,
             count(*) FILTER (WHERE COALESCE(amended_delivery_date, customer_delivery_date)
                                    < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)::int AS overdue_effective,
             count(*) FILTER (WHERE customer_delivery_date
                                    < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)::int AS overdue_original
      FROM scm.mfg_sales_orders
      WHERE status <> ALL(${TERMINAL})
      GROUP BY company_id ORDER BY company_id`;
    say('  company  overdue_by_EFFECTIVE  overdue_by_ORIGINAL');
    for (const r of rows) say(`  ${pad(r.company_id, 7)}  ${pad(r.overdue_effective, 19)}  ${pad(r.overdue_original, 19)}`);
    say('');
    say('  The gap is the count of orders the two engines disagree about being late.');
  });

  say('');
  if (failures > 0) {
    say(`INCOMPLETE — ${failures} section(s) failed. "not measured" is not "zero".`);
    process.exitCode = 1;
  } else {
    say('COMPLETE — all sections ran.');
  }
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error('PROBE_FAIL', e);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
