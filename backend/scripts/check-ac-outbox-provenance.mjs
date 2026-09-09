#!/usr/bin/env node
// Read-only: WHO put each row in the ERP -> AutoCount write-back queue.
//
// WHY THIS EXISTS. On 2026-09-09 the owner opened the write-back page and found
// 173 sales orders WAITING, all queued that day, and asked whether it was us:
//
//   「正常来说你的这批更改不应该是syncback autocount啊 应该remain啊」
//   「你不可以有记录再这边啊 这是你import进来的错误 所以没有影响这些啊」
//
// He is right, and the queue could not answer him. A cutover repair COPIES a
// value out of the account book; sending that same value back is pointless at
// best, and where the repair and the book disagree it overwrites his single
// source of truth. Those rows are an artefact of our own import work, not
// business activity — but scm.autocount_outbox records only WHAT was queued,
// never WHY, so "is this row a salesperson's save or our repair" was not a
// question the table could be asked.
//
// This report asks it from the evidence that IS there, and — this is the point
// — it reports the evidence rather than a verdict. Every bucket below is a
// COLUMN VALUE, not an inference:
//
//   created_by      the acting Houzs user id, stamped from c.get('houzsUser')
//                   at enqueue (autocount-outbox.ts:326). A route serving a
//                   logged-in human carries it. NULL is NOT proof of a script:
//                   the cron, the requeue tool and any unauthenticated path
//                   also leave it NULL, so NULL is reported as UNATTRIBUTED and
//                   is deliberately not called "repair".
//   created_at      when. The repair rounds are datable against the run log.
//   op / doc_type   what kind of operation.
//   dedupe_key      NULL on an edit by design (0277), so it does not classify.
//   last_error      the refusal reason on a skipped/failed row.
//
// WHAT THIS DOES NOT DO: decide. Cancelling a queued row is irreversible — it
// only comes back if the document is saved again — so the classification is a
// human's to make with this table in front of them. A row this report cannot
// attribute is printed under UNATTRIBUTED and left alone; the companion
// cancel script refuses to touch anything this one has not listed.
//
// Strictly read-only: SELECTs only, no DDL, no writes, no transaction. Exits 0
// for every legitimate answer — the answer is the output. Only an unreachable
// database exits non-zero.
//
// RE-RUN: inert. It writes nothing; a second run re-reads and re-prints.
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
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

/* The window the report details. Everything older is still counted in the
   totals; only the per-row listing is bounded, because the listing is what a
   human reads and 616 rows of history is not a report. */
const SINCE = process.env.SINCE || "2026-09-07T00:00:00Z";
const COMPANY = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : null;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

try {
  // ── the switch itself, not a sentence about it ────────────────────────────
  const flags = await pg`
    SELECT key, value FROM scm.app_config
    WHERE key IN ('scm.autocount_writeback', 'scm.write_freeze')
    ORDER BY key`;
  say("=== SWITCHES ===");
  for (const f of flags) say(`  ${f.key} = ${JSON.stringify(f.value)}`);
  if (!flags.length) say("  (neither row present)");
  say();

  // ── totals over the whole table ──────────────────────────────────────────
  const totals = await pg`
    SELECT status, op, count(*)::int AS n
    FROM scm.autocount_outbox
    ${COMPANY == null ? pg`` : pg`WHERE company_id = ${COMPANY}`}
    GROUP BY status, op
    ORDER BY status, op`;
  say("=== WHOLE QUEUE, status x op ===");
  let grand = 0;
  for (const r of totals) { grand += r.n; say(`  ${r.status.padEnd(8)} ${r.op.padEnd(10)} ${String(r.n).padStart(5)}`); }
  say(`  ${"TOTAL".padEnd(19)} ${String(grand).padStart(5)}`);
  say();

  // ── attribution: created_by across the table, and within the window ──────
  const attribution = await pg`
    SELECT
      (created_at >= ${SINCE}::timestamptz) AS in_window,
      status,
      (created_by IS NOT NULL)              AS attributed,
      count(*)::int                         AS n
    FROM scm.autocount_outbox
    ${COMPANY == null ? pg`` : pg`WHERE company_id = ${COMPANY}`}
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC, 2, 3 DESC`;
  say(`=== ATTRIBUTION (window starts ${SINCE}) ===`);
  say("  window  status    created_by      rows");
  for (const r of attribution) {
    say(`  ${(r.in_window ? "IN " : "old").padEnd(7)} ${r.status.padEnd(9)} ${(r.attributed ? "set" : "NULL").padEnd(15)} ${String(r.n).padStart(5)}`);
  }
  say();

  // ── who, by name, for the rows that DO carry a user ──────────────────────
  const byUser = await pg`
    SELECT o.created_by, u.name, u.email, o.status, count(*)::int AS n
    FROM scm.autocount_outbox o
    LEFT JOIN public.users u ON u.id = o.created_by
    WHERE o.created_by IS NOT NULL
      AND o.created_at >= ${SINCE}::timestamptz
      ${COMPANY == null ? pg`` : pg`AND o.company_id = ${COMPANY}`}
    GROUP BY o.created_by, u.name, u.email, o.status
    ORDER BY n DESC`;
  say("=== NAMED ACTORS IN THE WINDOW ===");
  if (!byUser.length) say("  (no row in the window carries a created_by)");
  for (const r of byUser) {
    say(`  id=${String(r.created_by).padEnd(6)} ${String(r.name ?? "(unknown)").padEnd(24)} ${r.status.padEnd(8)} ${String(r.n).padStart(5)}  ${r.email ?? ""}`);
  }
  say();

  // ── the minute-by-minute shape of the window ─────────────────────────────
  // A human saving orders spreads over the day; a script's rows land in bursts.
  // Reported as data (rows per hour, per op) so the reader draws the line.
  const burst = await pg`
    SELECT date_trunc('hour', created_at) AS hr, op, status, count(*)::int AS n,
           count(created_by)::int AS with_user
    FROM scm.autocount_outbox
    WHERE created_at >= ${SINCE}::timestamptz
      ${COMPANY == null ? pg`` : pg`AND company_id = ${COMPANY}`}
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3`;
  say("=== ROWS PER HOUR IN THE WINDOW ===");
  say("  hour(UTC)             op         status    rows  of which carry a user");
  for (const r of burst) {
    say(`  ${new Date(r.hr).toISOString().slice(0, 16)}   ${r.op.padEnd(10)} ${r.status.padEnd(9)} ${String(r.n).padStart(4)}  ${String(r.with_user).padStart(4)}`);
  }
  say();

  // ── every PENDING row, in full. This is the list a cancel would act on ───
  const pending = await pg`
    SELECT o.id, o.op, o.doc_type, o.doc_no, o.doc_id, o.company_id,
           o.created_at, o.created_by, u.name AS created_by_name,
           o.attempts, o.dedupe_key, o.last_error,
           (SELECT jsonb_agg(k ORDER BY k)
              FROM jsonb_object_keys(o.payload) k) AS payload_keys
    FROM scm.autocount_outbox o
    LEFT JOIN public.users u ON u.id = o.created_by
    WHERE o.status = 'pending'
      ${COMPANY == null ? pg`` : pg`AND o.company_id = ${COMPANY}`}
    ORDER BY o.created_at, o.doc_no`;
  say(`=== PENDING ROWS (${pending.length}) ===`);
  for (const r of pending) {
    say([
      r.created_at.toISOString(),
      r.op,
      r.doc_type,
      r.doc_no,
      `by=${r.created_by ?? "NULL"}${r.created_by_name ? `(${r.created_by_name})` : ""}`,
      `att=${r.attempts}`,
      `payload=[${(r.payload_keys ?? []).join(",")}]`,
      r.last_error ? `err=${String(r.last_error).slice(0, 60)}` : "",
    ].join("  "));
  }
  say();
} catch (e) {
  console.error("Database unreachable or query failed:", e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
