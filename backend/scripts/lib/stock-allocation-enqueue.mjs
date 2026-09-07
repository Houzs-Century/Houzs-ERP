// ---------------------------------------------------------------------------
// stock-allocation-enqueue.mjs — the script-side half of the SO stock-allocation
// invalidation queue.
//
// NO SHEBANG, ON PURPOSE. tests/ imports this module, and a `#!` in an imported
// .mjs is a load-time SyntaxError on Windows vitest (CLAUDE.md, "Anything a TEST
// imports lives in backend/scripts/lib/").
//
// WHY THIS EXISTS (traced 2026-09-08, defect: a script that writes stock leaves
// the readiness projection stale, silently, forever).
//
//   Every one of the ~38 allocation triggers hangs off the WORKER REQUEST PATH
//   (backend/src/index.ts, the cron comment says so in its own words). The
//   five-minute cron is a RETRY compensator for those triggers: it drains
//   scm.stock_allocation_recompute_queue, and that queue only ever gets a row
//   from a Worker.
//
//   backend/scripts/* do not go through the Worker. They open
//   `postgres(DATABASE_URL)` and write straight to Postgres. So a script that
//   moves stock produces NO queue row, the cron has nothing to pick up, and
//   mfg_sales_order_items.stock_status keeps answering the question the stock
//   used to answer. Nothing anywhere reports it. Tonight's inventory re-seed was
//   exactly that shape, which is why the recompute had to be run by hand after
//   it — and it is not a migration-only problem: after go-live, any script that
//   writes stock leaves the same silent gap.
//
// WHAT THIS IS, EXACTLY. A REPAIR REQUEST, not a durability guarantee. It is the
// same upsert `src/scm/lib/stock-allocation-queue.ts` performs, written in SQL
// for the `postgres` client the scripts hold. The script has already committed
// its stock write by the time it calls this, so the row cannot be part of that
// transaction — read the SCOPE header in src/scm/lib/stock-allocation-job.ts
// before reading the word "durable" into it. What it DOES buy is the thing that
// was missing: the next cron sweep sees work, and the projection converges
// without a human remembering to dispatch a recompute.
//
// WHY `attempts` / `deferrals` / `state` ARE NOT IN THE PAYLOAD. Same reason as
// the TypeScript enqueue, and it must stay the same reason: this is an upsert on
// a SINGLETON row, so listing those columns would reset the failure counter on
// every new request and a permanently broken job could never reach its terminal
// DEAD state. On first INSERT the column defaults apply; on conflict only the
// three columns named here are overwritten. A row already parked in DEAD stays
// DEAD and the cron keeps shouting about it — which is correct: a dead-lettered
// projection is a human's problem, and a script must not be able to launder it
// back into PENDING.
// ---------------------------------------------------------------------------

/** The queue's singleton key. One recompute at a time across the whole system. */
export const STOCK_ALLOCATION_JOB_KEY = 'GLOBAL';

/**
 * Ask the five-minute cron for a global SO stock-allocation recompute.
 *
 * @param {import('postgres').Sql} sql   a `postgres` client (the scripts' own)
 * @param {string} reason                who is asking, for the queue row and the log
 * @returns {Promise<{queued: true, reason: string, state: string}>}
 *
 * Throws if the row could not be written. That is deliberate: a script that
 * moved stock and could not register the invalidation has left the projection
 * stale, and the operator has to know that NOW, not from a readiness report a
 * week later.
 */
export async function enqueueStockAllocationRecompute(sql, reason) {
  if (!reason || String(reason).trim() === '') {
    throw new Error('enqueueStockAllocationRecompute: reason is required — an unattributed queue row cannot be traced back to what moved stock');
  }
  const rows = await sql`
    INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, requested_at, reason)
    VALUES (${STOCK_ALLOCATION_JOB_KEY}, gen_random_uuid(), now(), ${reason})
    ON CONFLICT (job_key) DO UPDATE
      SET request_token = EXCLUDED.request_token,
          requested_at  = EXCLUDED.requested_at,
          reason        = EXCLUDED.reason
    RETURNING state`;
  const state = rows[0]?.state ?? 'PENDING';
  return { queued: true, reason, state };
}

/**
 * The line a script prints after calling the enqueue. Separate from the write so
 * the operator sees the ONE outcome that is not routine: a queue row parked in
 * DEAD means allocation has already stopped and stays stopped until a human
 * clears it, so this request will never be drained.
 */
export function stockAllocationEnqueueNote({ state, reason }) {
  return state === 'DEAD'
    ? `stock-allocation recompute REQUESTED (${reason}) but the queue row is DEAD-LETTERED — the cron will NOT drain it. Clear the row per docs/modules/sales-order.md before trusting any readiness figure.`
    : `stock-allocation recompute queued (${reason}) — the five-minute cron will drain it.`;
}
