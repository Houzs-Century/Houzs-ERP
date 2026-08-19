// Sentinel: is the AutoCount inbound pull MOVING DATA, or only reporting that
// it ran? Exits NON-ZERO on alarm — the failed-workflow email is the only
// notifier this repo has.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS, and why a diagnostic was not enough
// ---------------------------------------------------------------------------
//
// At the Postgres cutover, `services/pull.ts`'s INSERT into `sales_orders` was
// carried over from the D1 schema and named seven columns the Postgres table
// does not have. Postgres answers an unknown column with 42703 and refuses the
// WHOLE statement, so every sales-order row failed. And the advance is guarded:
//
//     if (mode === "filtered" && failed === 0) { ...advance pull_checkpoint... }
//
// One failure freezes the checkpoint. EVERY row failing froze it at the cutover
// date, so the same window was refetched forever and the mirror took nothing.
// Each per-row failure is caught and counted, so the job kept reporting
// normal-looking runs the entire time.
//
// It ran every five minutes, for months, and moved nothing. Nobody saw it. It
// was found on 2026-08-19 by a salesperson who could not raise a Service Case
// against an order that plainly exists in AutoCount — that is, by a person who
// could not do their job.
//
// `check-autocount-pull-health.mjs` was written the same day and prints all of
// this. It is a DIAGNOSTIC: manual dispatch, always exits 0, answers a question
// somebody already thought to ask. It could not have found this, because the
// whole failure is that nobody knew to ask.
//
// This file is the other half. It runs on a schedule and it SHOUTS.
//
// ---------------------------------------------------------------------------
// The alarms, and why each threshold is what it is
// ---------------------------------------------------------------------------
//
//   A. pull_checkpoint is STALE. The pull runs every five minutes, so any
//      staleness beyond a couple of days is unambiguous: some row is failing
//      and the `failed === 0` guard has frozen the advance. Threshold 2 days,
//      taken from check-autocount-pull-health.mjs (`behind > 2`) rather than
//      invented here, so the two files cannot drift into disagreeing.
//
//   B. NOTHING ARRIVED in 30 days. This is the shape that actually hid: a
//      checkpoint can look healthy while the mirror takes nothing. For a live
//      ERP mirror, 30 days of zero writes is not a quiet month.
//
//   C. pull_checkpoint IS MISSING. pull.ts falls back to '2000-01-01', which is
//      not a leak but is not a working incremental pull either.
//
// CALIBRATION, stated honestly: A and C need no calibration — they are
// structural. B's 30 days has NOT been calibrated against this book's live
// arrival distribution; it is deliberately far looser than any plausible quiet
// period so that its first firing is a real answer and not a tuning exercise.
// To tighten it, read the real distribution first:
//     select date_trunc('week', updated_at::timestamptz), count(*)
//       from sales_orders group by 1 order by 1 desc limit 12;
//
// ---------------------------------------------------------------------------
// Read-only: SELECTs only. No DDL, no writes, no transaction.
// EXIT 0 healthy · 1 ALARM · 2 the sentinel COULD NOT ANSWER.
//
// Exit 2 matters as much as exit 1. A sentinel that cannot see must not report
// green: CLAUDE.md calls that "the check that is not running", and this repo has
// already paid for it twice — `audit:map` reported nothing for three weeks while
// crashing, and the nightly staging E2E passed for a fortnight against a build
// nobody had deployed. Silence from a broken watchman reads exactly like peace.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import postgres from "postgres";

import { ALARM, CANNOT_ANSWER, OK, decide } from "./lib/autocount-pull-rules.mjs";

function resolveUrl() {
  if (process.env.SENTINEL_HOUZS_DB_URL) return process.env.SENTINEL_HOUZS_DB_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("autocount-pull-sentinel: no database URL. CANNOT ANSWER.");
  process.exit(CANNOT_ANSWER);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/** Days between an ISO-ish string and now, or null if it will not parse. */
const daysSince = (iso) => {
  const t = Date.parse(String(iso).replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

const notes = [];
let verdict;

try {
  const cp = await pg`SELECT value FROM system_settings WHERE key = 'pull_checkpoint'`;
  const checkpoint = cp[0]?.value ?? null;
  const behind = checkpoint ? daysSince(checkpoint) : null;
  notes.push(`pull_checkpoint = ${checkpoint ?? "(not set)"} (${behind === null ? "UNPARSEABLE" : behind + "d behind"})`);

  /* `updated_at` is TEXT on this table, not a timestamp — the pull writes
     datetime('now') straight through from the D1 era. Comparing it to now()
     raises 42883 (`text >= timestamp with time zone`). Cast rather than trust
     the column's name; that mistake killed the first run of the diagnostic. */
  const rate = await pg`
    SELECT
      count(*) FILTER (WHERE updated_at::timestamptz >= now() - interval '7 days')  AS d7,
      count(*) FILTER (WHERE updated_at::timestamptz >= now() - interval '30 days') AS d30,
      count(*)                                                                      AS total
    FROM sales_orders
   WHERE updated_at IS NOT NULL AND updated_at <> ''`;

  const d7 = Number(rate[0].d7);
  const d30 = Number(rate[0].d30);
  const total = Number(rate[0].total);
  notes.push(`rows with a timestamp: ${total} | touched 7d: ${d7} | 30d: ${d30}`);

  verdict = decide({ checkpoint, behind, d7, d30, total });
} catch (e) {
  console.error(`autocount-pull-sentinel: query failed — ${e.message}`);
  console.error("CANNOT ANSWER. A sentinel that cannot see must not report green.");
  await pg.end({ timeout: 5 });
  process.exit(CANNOT_ANSWER);
}

await pg.end({ timeout: 5 });

console.log("-- AutoCount inbound pull sentinel ------------------------------");
for (const n of notes) console.log(`   ${n}`);
console.log("");

if (verdict.code === CANNOT_ANSWER) {
  console.error(`CANNOT ANSWER: ${verdict.reason}`);
  process.exit(CANNOT_ANSWER);
}

if (verdict.code === OK) {
  console.log("HEALTHY: the checkpoint is current and rows are arriving.");
  console.log("");
  console.log("Note what this does NOT prove: that the HISTORY is complete. The");
  console.log("incremental pull asks getSince(checkpoint), so an order last modified");
  console.log("before the mirror's earliest checkpoint was never offered and never");
  console.log("will be. That backlog is collected with a windowed ?since= backfill —");
  console.log("see docs/modules/system-health.md — and this sentinel cannot see it.");
  console.log("");
  console.log("-- read-only. Nothing was written. ------------------------------");
  process.exit(OK);
}

console.error(`ALARM — ${verdict.alarms.length} condition(s):`);
for (const a of verdict.alarms) console.error(`
  * ${a}`);
console.error("");
console.error("Next: run the AutoCount pull health check (workflow_dispatch,");
console.error("read-only) for the full picture before changing anything.");
console.error("");
console.error("-- read-only. Nothing was written. ------------------------------");
process.exit(ALARM);
