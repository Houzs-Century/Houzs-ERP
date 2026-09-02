#!/usr/bin/env node
// Ask the WORKER to recompute SO stock allocation, by writing the queue's
// singleton repair-request row (scm.stock_allocation_recompute_queue,
// job_key GLOBAL) — the five-minute cron drains it and runs the canonical
// recompute with the Worker's own client.
//
// WHY THIS EXISTS. recompute-so-allocation.yml borrows the canonical function
// into Actions through scripts/lib/pgrest-shim.mjs, and on 2026-08-28 that
// shim died mid-sweep ("savepoint pgrest_sp_6 does not exist", and .upsert is
// not implemented for the retry row). The queue row is the PRODUCTION path —
// stock-allocation-queue.ts calls this exact upsert a "REPAIR REQUEST — a row
// the five-minute cron will pick up". This script writes that request and
// nothing else; the allocation itself runs in the Worker.
//
// MODE: plan (default) prints the current queue row and company-1 line-status
// counts; APPLY=1 + CONFIRM="ENQUEUE ALLOCATION RECOMPUTE" writes the request.
// RE-RUN: idempotent — it is an upsert on the singleton row; a second run just
// refreshes the request timestamp. Run plan again ~10 minutes after apply to
// see the row consumed and the READY counts move.
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
if (APPLY && process.env.CONFIRM !== "ENQUEUE ALLOCATION RECOMPUTE") {
  console.error('APPLY=1 needs CONFIRM="ENQUEUE ALLOCATION RECOMPUTE" — refusing.');
  process.exit(2);
}
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function state(tag, s) {
  const rows = await s`SELECT job_key, attempts, requested_at, locked_by, locked_until, last_error, reason
    FROM scm.stock_allocation_recompute_queue WHERE job_key = 'GLOBAL'`;
  log(`${tag} queue row: ${rows.length ? JSON.stringify(rows[0]) : "(none — nothing pending)"}`);
  const counts = await s`SELECT COALESCE(i.stock_status,'(null)') st, COUNT(*) n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL AND i.cancelled = false
    GROUP BY 1 ORDER BY 2 DESC`;
  log(`${tag} company-1 imported line stock_status: ${counts.map((r) => `${r.st}=${r.n}`).join("  ")}`);
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"}`);
  await state("BEFORE", sql);
  if (!APPLY) { log('PLAN ONLY — APPLY=1 CONFIRM="ENQUEUE ALLOCATION RECOMPUTE" writes the request.'); await sql.end(); return; }

  const token = randomUUID();
  await sql`INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, requested_at, reason)
    VALUES ('GLOBAL', ${token}, now(), ${"2026-08 re-import: mirrors + stock landed; light up READY"})
    ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token,
      requested_at = EXCLUDED.requested_at, reason = EXCLUDED.reason`;
  log(`request written (token ${token}).`);

  /* fresh-connection SHAPE verify: the row exists and holds OUR token */
  const vsql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const [row] = await vsql`SELECT request_token, reason FROM scm.stock_allocation_recompute_queue WHERE job_key = 'GLOBAL'`;
  if (!row || row.request_token !== token) {
    log(`VERIFY FAILED: row ${row ? "holds a different token (another writer raced us — fine, a request is pending either way)" : "is MISSING"}`);
    if (!row) { await vsql.end(); await sql.end(); process.exit(1); }
  } else {
    log("VERIFY (fresh connection): the request row holds our token, byte for byte.");
  }
  log("The Worker's five-minute cron drains this row and recomputes. Run this script in PLAN mode in ~10 minutes to watch it consumed and the READY counts move.");
  await vsql.end();
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
