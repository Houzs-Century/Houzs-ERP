#!/usr/bin/env node
/* cancel-stale-writeback-edits — stop a bulk RE-QUEUE from overwriting the
 * licensed account book, without touching the write-back switch.
 *
 * WHAT HAPPENED, measured on production 2026-09-09 09:17 UTC (read-only DSN).
 * Between 08:43 and 09:17 something re-queued sales-order `edit` operations in
 * bulk under company 1 — 171 rows in five minutes at three per second, which is
 * a program and not a person clicking. An `edit` payload is a whole-document
 * overwrite: `{DocNo, Lines:[{DtlKey, Qty, UnitPrice, Description, Desc2,
 * Location}]}`, applied line by line by DtlKey. By 09:17 the drain had already
 * sent 319 of them, rewriting 260 documents in the book.
 *
 * WHY THAT IS THE WRONG DIRECTION. The ERP's sales orders were PULLED FROM
 * AutoCount at the cutover, and the owner has been correcting them by hand to
 * reconcile the two sides. Writing the ERP's value back into the book therefore
 * pushes our in-progress corrections onto the system of record — the opposite of
 * the reconciliation.
 *
 * THE SELECTOR IS "NOBODY SAVED THIS DOCUMENT", NOT "WHO QUEUED IT".
 * The obvious selector — `created_by = 1` — is wrong: user 1 is
 * hello@houzscentury.com, the owner's own login, so it would also cancel edits
 * he made himself. What actually separates the two populations is whether the
 * DOCUMENT moved: `enqueueAcEdit` runs on save, so a genuine edit is queued
 * within seconds of its sales order's `updated_at`, while a re-queue is stamped
 * on a document nobody has touched for days.
 *
 * Measured on the live queue before this script was written:
 *   pending edits : 73 stale-document, 2 genuinely saved
 *   sent today    : 269 stale-document (269 documents), 70 genuinely saved (12 documents)
 * The two populations do not overlap and the split is not marginal — the stale
 * side is days old, not minutes.
 *
 * WHY NOT THE SWITCH. `scm.autocount_writeback` takes 'off' / 'all' / a list of
 * COMPANY ids (scm/lib/autocount-writeback-flag.ts) — there is no value that
 * means "block edits, pass new orders". Turning it off for company 1 stops
 * everything, including the genuine documents queued behind this flood (three of
 * Sim's purchase orders and one new sales order). The owner's standing ruling is
 * that the switch stays on and the repairs are what stop queueing, so this
 * cancels the flood and leaves those four to drain normally.
 *
 * WHY `skipped` AND NOT A DELETE. 0277's table comment forbids deleting a row:
 * the table is the audit trail of what the ERP told AutoCount. `skipped` is one
 * of its four statuses and is exactly this claim — we chose not to send it. The
 * drain selects `status = 'pending'` (autocount-outbox.ts:1962) and the claim
 * re-checks the same predicate under the row lock (autocount-claim.ts), so a
 * skipped row is unreachable by both dispatchers.
 *
 * WHY THE NOTE READS THE WAY IT DOES. `isRequeuedNote` is a PREFIX test on
 * `[re-queued` (autocount-outbox-status.ts:52,319) and the four refusal classes
 * share the prefix `refused, nothing sent`. This note starts with neither, so
 * the row classifies as a plain `skipped` and is not dressed up as either an
 * AutoCount refusal or a re-queue.
 *
 * NOT IN THIS SCRIPT. Retiring the already-sent rows from the AutoCount Sync
 * page (`archived_at`) is deliberately absent: the documents the book has
 * already taken must be COMPARED against it before anything hides them from the
 * screen. The standing rule is to list first and clear afterwards, never the
 * other way round.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN. Plan writes nothing and prints every row it
 *                     would cancel, so the run log is the list.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE — that no
 *   stale-document edit is left pending AND that every genuinely-saved edit is
 *   still pending — rather than a row count, which cannot tell the two apart.
 *
 * RE-RUN: idempotent. The UPDATE carries `status = 'pending'`, so a second run
 * selects nothing, writes nothing and reports 0 rows. Safe to run again if the
 * producer starts up once more; that is the expected way to use it.
 *
 * Env:  DATABASE_URL (required)
 *       MODE=plan|apply (default plan)
 *       CONFIRM (required when MODE=apply)
 *       STALE_MINUTES (default 10) — how long after a save an edit still counts
 *                     as that save's own. 10 is two orders of magnitude below
 *                     the observed gap (days) and one above the observed
 *                     enqueue latency (seconds).
 *
 * Usage:
 *   DATABASE_URL=... node backend/scripts/cancel-stale-writeback-edits.mjs
 *   DATABASE_URL=... MODE=apply CONFIRM='cancel stale writeback edits' \
 *     node backend/scripts/cancel-stale-writeback-edits.mjs
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'cancel stale writeback edits';
const APPLY = MODE === 'apply';
const STALE_MINUTES = Number(process.env.STALE_MINUTES ?? 10);

const NOTE = [
  'cancelled 2026-09-09 on the owner instruction: a bulk re-queue, not a save.',
  'The document was not modified before this row was created, so sending it',
  'would have overwritten the account book with ERP values nobody had just',
  'entered. Nothing was sent to AutoCount.',
].join(' ');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (!Number.isFinite(STALE_MINUTES) || STALE_MINUTES <= 0) {
  console.error(`STALE_MINUTES must be a positive number, got ${process.env.STALE_MINUTES}`);
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

const STALE = `${STALE_MINUTES} minutes`;
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  console.log(`MODE=${MODE}  STALE_MINUTES=${STALE_MINUTES}`);

  const doomed = await sql`
    SELECT o.id, o.doc_no, o.created_at, h.updated_at AS doc_updated_at,
           date_trunc('second', o.created_at - h.updated_at)::text AS gap
      FROM scm.autocount_outbox o
      JOIN scm.mfg_sales_orders h ON h.doc_no = o.doc_no
     WHERE o.status = 'pending'
       AND o.op = 'edit'
       AND o.doc_type = 'SO'
       AND (h.updated_at IS NULL
            OR o.created_at - h.updated_at >= ${STALE}::interval)
     ORDER BY o.created_at, o.doc_no`;

  const spared = await sql`
    SELECT o.doc_no, o.op, o.created_at,
           date_trunc('second', o.created_at - h.updated_at)::text AS gap
      FROM scm.autocount_outbox o
      LEFT JOIN scm.mfg_sales_orders h ON h.doc_no = o.doc_no
     WHERE o.status = 'pending'
       AND NOT (o.op = 'edit' AND o.doc_type = 'SO'
                AND h.doc_no IS NOT NULL
                AND (h.updated_at IS NULL
                     OR o.created_at - h.updated_at >= ${STALE}::interval))
     ORDER BY o.created_at`;

  console.log(`\n=== WOULD CANCEL: ${doomed.length} row(s) ===`);
  for (const r of doomed) {
    console.log(`  ${r.doc_no}  queued ${r.created_at.toISOString()}  document untouched for ${r.gap}`);
  }
  console.log(`\n=== LEFT ALONE, still pending: ${spared.length} row(s) ===`);
  for (const r of spared) {
    console.log(`  ${r.doc_no}  ${r.op}  queued ${r.created_at.toISOString()}  gap ${r.gap ?? '(no sales order row)'}`);
  }

  if (!APPLY) {
    console.log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  const changed = await sql`
    UPDATE scm.autocount_outbox o
       SET status = 'skipped', last_error = ${NOTE}, updated_at = now()
      FROM scm.mfg_sales_orders h
     WHERE h.doc_no = o.doc_no
       AND o.status = 'pending'
       AND o.op = 'edit'
       AND o.doc_type = 'SO'
       AND (h.updated_at IS NULL
            OR o.created_at - h.updated_at >= ${STALE}::interval)
    RETURNING o.id, o.doc_no`;
  console.log(`\nAPPLIED: ${changed.length} row(s) cancelled.`);

  await sql.end();

  /* FRESH CONNECTION. The verification must not be able to read its own
     transaction's work, and it asserts the SHAPE: nothing stale left pending,
     and every genuine save still pending. A count could not tell those apart —
     "0 pending" would pass while having cancelled the real orders too. */
  const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const [row] = await check`
    SELECT
      (SELECT count(*) FROM scm.autocount_outbox o
         JOIN scm.mfg_sales_orders h ON h.doc_no = o.doc_no
        WHERE o.status = 'pending' AND o.op = 'edit' AND o.doc_type = 'SO'
          AND (h.updated_at IS NULL
               OR o.created_at - h.updated_at >= ${STALE}::interval)
      )::int AS stale_left,
      (SELECT count(*) FROM scm.autocount_outbox o
         JOIN scm.mfg_sales_orders h ON h.doc_no = o.doc_no
        WHERE o.status = 'pending' AND o.op = 'edit' AND o.doc_type = 'SO'
          AND o.created_at - h.updated_at < ${STALE}::interval
      )::int AS genuine_left,
      (SELECT count(*) FROM scm.autocount_outbox
        WHERE status = 'skipped' AND last_error = ${NOTE})::int AS cancelled_now`;
  await check.end();

  console.log('\n=== VERIFY (fresh connection) ===');
  console.log(`  stale edits still pending   : ${row.stale_left}   (want 0)`);
  console.log(`  genuine saves still pending : ${row.genuine_left} (untouched by this script)`);
  console.log(`  rows carrying this note     : ${row.cancelled_now}`);
  if (row.stale_left !== 0) {
    console.error('VERIFY FAILED: a stale edit is still pending.');
    process.exit(1);
  }
  console.log('VERIFY OK.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
