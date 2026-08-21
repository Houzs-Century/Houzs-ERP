#!/usr/bin/env node
/* Give the imported 2990 orders the Processing Date the house rule requires.

   THE RULE, the owner's, restated 2026-08-21:
     "我们的规则是有 delivery date 就必须有 processing date"
   and, asked what to fill the gap with:
     "就用 PO 的前一天放" … "那就用开单的日期" (for the ones with no PO).

   WHY THESE ROWS EXIST AT ALL, and why this is a repair and not a new rule.
   The both-dates-or-neither gate (`soDatePairRefusal`) runs on every path where
   HOUZS authors the write. It deliberately does NOT run on `/api/sync/so-mirror`
   — that route is a one-way replica of rows 2990 had already committed in its
   own database, and refusing one would keep it PENDING in 2990's outbox and
   wedge the queue behind it for every later order. So the exemption bought
   availability, and these rows are what it cost.

   MEASURED, not assumed (probe-so-date-xor, run 32487477175, 2026-08-21):
     company 2: 104 sales orders — 43 both dates, 33 neither,
                28 DELIVERY-ONLY, 0 processing-only.
     All 28 created 2026-06-11 .. 2026-07-12; ZERO in the last 30 days.
     company 1: 0 sales orders at all (run 32487749630).
   So this is a CLOSED historical population. Houzs took the 2990 write path on
   2026-07-21 (HOUZS_OWNS_2990), every later state is authored here, and the
   pair gate has applied to all of it. Nothing is still producing these.

   ── WHAT EACH ROW GETS ──────────────────────────────────────────────────────

     has a linked purchase order  ->  the EARLIEST po_date, minus one day
     no linked purchase order     ->  the order's own so_date (开单日期)

   EARLIEST, not latest: an order can raise several purchase orders, and the
   Processing Date means "this order was released to purchasing" — the release
   is the first time purchasing acted on it, not the last.

   THE PAIR RULE IS ALSO AN ORDERING RULE, and it constrains the answer.
   `collectProcessingGateProblems` enforces processing <= delivery on every
   authored write. A backfill that ignored it would write rows the app's own
   gate would refuse on the next edit — the exact shape of a repair that has to
   be repaired. So:

     1. try PO-minus-one-day; if it is after the delivery date, fall back to
     2. so_date; if THAT is also after the delivery date,
     3. REFUSE the row, leave it NULL, and list it for the owner.

   Step 3 is deliberate. A row whose own document date is later than the
   delivery date it promises is not a missing-date problem, it is a
   disagreeing-dates problem, and inventing a value would bury it.

   ── WHY A DIRECT UPDATE IS SAFE HERE, stated so nobody has to re-derive it ──
   Writing this column through SQL bypasses the app entirely: no AutoCount
   outbox row is enqueued, no allocation sweep runs, no edit lease is taken.
   And the allocator would be inert on these rows anyway — every one of the 28
   is CONFIRMED (19) or DELIVERED (9), and `recomputeSoStockAllocation` drops a
   line whose deliverable remaining is <= 0 before it ever reads the gate.
   What DOES change is the edit lock: `soProcessingLocked` fires on a non-null
   processing_date, so these orders become processing-locked. That is the
   intended consequence of the rule, not a side effect — an order released to
   purchasing is meant to be locked.

   MODE=dry-run (default) runs every write inside a transaction and ROLLS BACK.
   MODE=apply requires CONFIRM="I HAVE REVIEWED THE DRY-RUN".

   RE-RUN: idempotent. The selection is `processing_date IS NULL`, so a second
   run finds the rows it already filled are no longer eligible and writes zero.
   A row refused at step 3 stays eligible and is re-listed every run, which is
   the point — it is an open question, not a completed repair. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
const APPLY = (process.env.MODE || 'dry-run').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY || 2);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!DSN) { bad('DATABASE_URL is not set'); process.exit(1); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(1);
}

const ymd = (d) => (d == null ? null : String(d).slice(0, 10));
const minusOneDay = (d) => {
  const t = new Date(`${ymd(d)}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  note(`=== backfill-so-processing-date-from-po  mode=${APPLY ? 'APPLY' : 'DRY-RUN (everything rolls back)'}  company=${CO} ===`);

  /* The population, by the same predicate probe-so-date-xor counts. */
  const targets = await sql`
    SELECT doc_no, status, so_date, customer_delivery_date
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO}
       AND processing_date IS NULL
       AND customer_delivery_date IS NOT NULL
     ORDER BY so_date, doc_no`;
  note(`orders with a delivery date and no processing date: ${targets.length}`);
  if (targets.length === 0) {
    note('nothing to do.');
    await sql.end({ timeout: 5 });
    return;
  }

  /* Earliest purchase-order date per SO, through the line link (mig 0098):
     purchase_order_items.so_item_id -> mfg_sales_order_items.id -> .doc_no.
     A CANCELLED purchase order is excluded — it is not a release to
     purchasing, and so-converted-po.ts drops it from the UI for the same
     reason. */
  const docNos = targets.map((r) => r.doc_no);
  const poRows = await sql`
    SELECT soi.doc_no AS doc_no, min(po.po_date) AS first_po_date
      FROM scm.purchase_order_items poi
      JOIN scm.mfg_sales_order_items soi ON soi.id = poi.so_item_id
      JOIN scm.purchase_orders po        ON po.id = poi.purchase_order_id
     WHERE soi.doc_no = ANY(${docNos})
       AND po.status <> 'CANCELLED'
     GROUP BY soi.doc_no`;
  const firstPoBySo = new Map(poRows.map((r) => [r.doc_no, ymd(r.first_po_date)]));

  const plan = [];
  const refused = [];
  for (const r of targets) {
    const deliv = ymd(r.customer_delivery_date);
    const soDate = ymd(r.so_date);
    const poDate = firstPoBySo.get(r.doc_no) ?? null;

    let value = null;
    let basis = null;
    if (poDate) {
      const candidate = minusOneDay(poDate);
      if (candidate <= deliv) { value = candidate; basis = `PO ${poDate} minus 1 day`; }
    }
    if (value == null && soDate != null && soDate <= deliv) {
      value = soDate;
      basis = poDate ? `so_date (PO ${poDate} minus 1 day is after the delivery date)` : 'so_date (no purchase order)';
    }
    if (value == null) {
      refused.push({ ...r, deliv, soDate, poDate });
      continue;
    }
    plan.push({ docNo: r.doc_no, status: r.status, value, basis, deliv });
  }

  note(`\n=== PLAN — ${plan.length} row(s) ===`);
  for (const p of plan) {
    note(`  ${String(p.docNo).padEnd(20)} ${String(p.status).padEnd(11)} processing_date = ${p.value}   (${p.basis}; delivery ${p.deliv})`);
  }

  note(`\n=== REFUSED — ${refused.length} row(s), left NULL on purpose ===`);
  if (refused.length === 0) note('  none');
  for (const r of refused) {
    note(`  ${String(r.doc_no).padEnd(20)} so_date ${r.soDate} and PO ${r.poDate ?? '(none)'} are BOTH after delivery ${r.deliv} — the dates disagree; this is not a missing-date row`);
  }

  /* THE WRITE. One transaction; the dry run rolls it back, so the dry run
     exercises the real UPDATE rather than a description of one. */
  let wrote = 0;
  await sql.begin(async (tx) => {
    for (const p of plan) {
      const res = await tx`
        UPDATE scm.mfg_sales_orders
           SET processing_date = ${p.value}::date,
               updated_at = now()
         WHERE doc_no = ${p.docNo}
           AND company_id = ${CO}
           AND processing_date IS NULL`;
      wrote += res.count;
    }
    note(`\n${APPLY ? 'wrote' : 'would write'}: ${wrote} row(s)`);
    if (!APPLY) throw new ROLLBACK();
  }).catch((e) => { if (!(e instanceof ROLLBACK)) throw e; });

  if (!APPLY) {
    note('\nDRY-RUN — the transaction was rolled back. Nothing was written.');
    await sql.end({ timeout: 5 });
    return;
  }

  /* VERIFY ON A FRESH CONNECTION, AND ASSERT THE SHAPE — not the count. A row
     count answers "did an UPDATE match", which was true while the jsonb
     double-encoding repair was corrupting the column it reported 7 of 7 on.
     What matters here is that the value is a real DATE, that it is not after
     the delivery date it was written against, and that the population the rule
     is about is now empty. */
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    /* Re-read the VALUES, not a predicate over them. `pg_typeof` would have
       been the classic check that answers a different question: the column is
       DATE by DDL, so it can only ever answer 'date' and would have read as a
       pass over a column full of wrong days. Compare each stored value against
       the day this run intended to write. */
    const back = await check`
      SELECT doc_no, processing_date, customer_delivery_date
        FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND doc_no = ANY(${plan.map((p) => p.docNo)})`;
    const got = new Map(back.map((r) => [r.doc_no, r]));
    const mismatched = [];
    for (const p of plan) {
      const r = got.get(p.docNo);
      if (!r) { mismatched.push(`${p.docNo}: row not found on re-read`); continue; }
      const stored = ymd(r.processing_date);
      if (stored !== p.value) mismatched.push(`${p.docNo}: stored ${stored}, intended ${p.value}`);
      if (stored != null && ymd(r.customer_delivery_date) != null && stored > ymd(r.customer_delivery_date)) {
        mismatched.push(`${p.docNo}: ${stored} is AFTER its delivery date ${ymd(r.customer_delivery_date)}`);
      }
    }
    const [remaining] = await check`
      SELECT count(*)::int AS n FROM scm.mfg_sales_orders
       WHERE company_id = ${CO}
         AND processing_date IS NULL AND customer_delivery_date IS NOT NULL`;

    note(`\n=== VERIFY (fresh connection, values re-read) ===`);
    note(`  rows re-read                              : ${back.length} of ${plan.length}`);
    note(`  values that disagree with the plan        : ${mismatched.length}   (must be 0)`);
    for (const m of mismatched) note(`    ${m}`);
    note(`  company ${CO} still delivery-only          : ${remaining.n}   (expected ${refused.length}, the refused rows)`);

    const ok = mismatched.length === 0 && back.length === plan.length
      && remaining.n === refused.length;
    if (!ok) { bad('VERIFICATION FAILED — read the numbers above before doing anything else.'); process.exit(1); }
    note('  VERIFIED.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

class ROLLBACK extends Error {}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch {}
  process.exit(1);
});
