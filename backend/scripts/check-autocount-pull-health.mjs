// Read-only: is the AutoCount inbound pull actually MOVING DATA, or only
// reporting that it ran?
//
// WHY THIS EXISTS — the failure it is built to make visible has already happened
// once, silently, for months.
//
// At the Postgres cutover, `services/pull.ts`'s INSERT into `sales_orders` was
// carried over verbatim from the old D1 schema and named SEVEN columns that do
// not exist on the Postgres table (`transfer_to`, `note`, `inv_addr1..4`,
// `sync_error`). Postgres answers an unknown column with 42703 and refuses the
// WHOLE statement, so every sales-order row failed. And the advance is guarded:
//
//     if (mode === "filtered" && failed === 0) { ...advance pull_checkpoint... }
//
// One failure freezes the checkpoint. Every row failing froze it at the cutover
// date, so the same window was refetched forever and the mirror took nothing.
// Each per-row failure was caught and counted, so the job kept reporting a
// normal-looking run. The INSERT is fixed now; what nobody can see from the code
// is whether the BACKLOG was ever collected, because that lives in one row of
// `system_settings`.
//
// So this reports the three numbers that separate "running" from "working":
//
//   1. where `pull_checkpoint` is, and how far behind now that is
//   2. the newest `doc_no` / `doc_date` actually in the mirror
//   3. how many rows arrived in the last 7 / 30 days
//
// A pull that runs every five minutes and has added nothing for weeks is the
// shape this catches, and it is invisible in every other place we look.
//
// Strictly read-only: three SELECTs, no DDL, no writes, no transaction.
// EXITS 0 for every legitimate answer — the ANSWER is the output. A red job
// reads as "the check broke".
// RE-RUN: idempotent. It reads and prints.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("check-autocount-pull-health: no DATABASE_URL.");
  process.exit(1);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const days = (iso) => {
  const t = Date.parse(String(iso).replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

try {
  // 1. the checkpoint — one row, and the whole story of whether it moves
  const cp = await pg`
    SELECT value FROM system_settings WHERE key = 'pull_checkpoint'`;
  const at = cp[0]?.value ?? null;
  console.log("-- 1. pull_checkpoint ------------------------------------------");
  if (!at) {
    console.log("   NOT SET. pull.ts falls back to '2000-01-01', so the next filtered");
    console.log("   run asks AutoCount for everything since 2000 — slow, but not a leak.");
  } else {
    const behind = days(at);
    console.log(`   value        ${at}`);
    console.log(`   behind by    ${behind === null ? "(unparseable)" : behind + " day(s)"}`);
    if (behind !== null && behind > 2) {
      console.log("   ^ THE CHECKPOINT IS STUCK. It only advances on a run with ZERO");
      console.log("     failures, so one bad row freezes it and the same window is");
      console.log("     refetched forever. This is the exact shape of the cutover bug.");
    }
  }

  // 2. what the mirror actually holds
  const newest = await pg`
    SELECT doc_no, doc_date, updated_at
      FROM sales_orders
     ORDER BY doc_date DESC NULLS LAST
     LIMIT 3`;
  const total = await pg`SELECT count(*) AS n FROM sales_orders`;
  console.log("");
  console.log("-- 2. what is IN the mirror ------------------------------------");
  console.log(`   rows total   ${total[0].n}`);
  for (const r of newest) {
    console.log(`   newest       ${r.doc_no}  doc_date=${r.doc_date ?? "-"}  updated=${r.updated_at ?? "-"}`);
  }

  // 3. arrival rate — the number that says "moving" or "not"
  const rate = await pg`
    SELECT
      count(*) FILTER (WHERE updated_at >= now() - interval '7 days')  AS d7,
      count(*) FILTER (WHERE updated_at >= now() - interval '30 days') AS d30
    FROM sales_orders`;
  console.log("");
  console.log("-- 3. rows touched by the pull ---------------------------------");
  console.log(`   last 7 days  ${rate[0].d7}`);
  console.log(`   last 30 days ${rate[0].d30}`);

  console.log("");
  console.log("-- VERDICT ------------------------------------------------------");
  const behind = at ? days(at) : null;
  if (Number(rate[0].d7) === 0 && Number(rate[0].d30) === 0) {
    console.log("   NOT MOVING. The mirror has taken nothing in 30 days. The pull may");
    console.log("   still be reporting successful runs — it counts per-row failures and");
    console.log("   carries on. Run the pull in 'all' mode: pull.ts:29 says that path");
    console.log("   uses /getAll and does NOT touch the checkpoint, so it is the clean");
    console.log("   way to collect a backlog without unfreezing anything by hand.");
  } else if (behind !== null && behind > 2) {
    console.log("   PARTIALLY MOVING: rows are arriving but the checkpoint is stale, so");
    console.log("   some run is still failing at least one row. Find that row first —");
    console.log("   advancing the checkpoint by hand would skip whatever it is.");
  } else {
    console.log("   HEALTHY: checkpoint current and rows arriving.");
  }
  console.log("");
  console.log("-- read-only. Nothing was written. ------------------------------");
} catch (e) {
  console.error(`check-autocount-pull-health: query failed — ${e.message}`);
  await pg.end({ timeout: 5 });
  process.exit(1);
}

await pg.end({ timeout: 5 });
