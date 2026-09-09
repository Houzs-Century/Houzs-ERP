#!/usr/bin/env node
// CANCEL THE QUEUED WRITE-BACKS THAT CAME FROM OUR CUTOVER REPAIRS — and only
// those.
//
// The owner, 2026-09-09, on finding 173 sales orders waiting in the queue:
//
//   「正常来说你的这批更改不应该是syncback autocount啊 应该remain啊」
//   「你不可以有记录再这边啊 这是你import进来的错误 所以没有影响这些啊」
//
// A repair COPIES a value out of the account book, so sending it back is
// pointless where they agree and overwrites his source of truth where they do
// not. Those rows should never have been created. A row a SALESPERSON caused
// must survive untouched — the write-back being live is the point of the ERP.
//
// ── CANCEL MEANS `skipped`, NOT `DELETE` ────────────────────────────────────
//
// scm.autocount_outbox's own comment (migration 0277): "Never delete rows: this
// is the audit trail of what the ERP told AutoCount." So a cancelled row STAYS,
// moves to `skipped`, and carries in last_error the reason and this script's
// name. A year from now "why did this document never reach AutoCount" is a
// SELECT rather than a memory. `skipped` is already the queue's word for "the
// ERP consciously will not send this", which is exactly what this is.
//
// ── IT CANNOT ACT ON A ROW NOBODY LISTED ────────────────────────────────────
//
// This is irreversible in the way that matters: a cancelled row only comes back
// if the document is SAVED again, and nobody is going to re-save 167 migrated
// sales orders. So the apply path takes an EXPLICIT list of outbox row ids in
// ONLY_IDS and touches nothing else. There is no "cancel everything matching a
// rule" mode, on purpose — a rule that is one character wrong cancels a
// salesperson's order silently, and the plan a human actually read is the only
// thing that makes this safe.
//
// The plan comes from check-ac-outbox-provenance.mjs. This script re-reads
// every id and REFUSES the whole batch if any of them:
//   · is not `pending` any more (it drained while you were reading the plan);
//   · carries a created_by (a named human caused it — never ours to cancel);
//   · is not in the company you named.
// Refusing the BATCH rather than skipping the row is deliberate: a partial
// apply against a list somebody reviewed as a whole is not the thing they
// approved.
//
// MODE: plan (default) | apply.  APPLY additionally needs
// CONFIRM="I HAVE REVIEWED THE OUTBOX CANCEL PLAN".
//
// RE-RUN: inert on a row already cancelled — it is no longer `pending`, so the
// batch refuses and names it. Re-running after a successful apply changes
// nothing and reports why.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch { return undefined; }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const MODE = (process.env.MODE || "plan").toLowerCase();
const CONFIRM_PHRASE = "I HAVE REVIEWED THE OUTBOX CANCEL PLAN";
const COMPANY = Number(process.env.COMPANY_ID || 1);
const REASON = process.env.REASON
  || "cancelled by cancel-ac-outbox-repair-rows.mjs: queued by a cutover repair, not by a person. "
   + "A repair copies a value out of the account book; sending it back would overwrite the owner's source of truth.";
const ONLY_IDS = (process.env.ONLY_IDS || "")
  .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const say = (s = "") => console.log(s);
let exitCode = 0;

try {
  if (MODE === "apply" && process.env.CONFIRM !== CONFIRM_PHRASE) {
    say(`APPLY refused: set CONFIRM="${CONFIRM_PHRASE}" to arm it.`);
    process.exit(0);
  }
  if (MODE === "apply" && ONLY_IDS.length === 0) {
    say("APPLY refused: ONLY_IDS is empty. This script cancels the rows you name and nothing else.");
    process.exit(0);
  }
  /* Shape-check the ids HERE rather than letting Postgres reject the cast. A
     mistyped id would otherwise come back through the catch below as "Database
     unreachable or query failed", which is a false statement about production
     and would send the next person to look at the network. */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const malformed = ONLY_IDS.filter((id) => !UUID.test(id));
  if (malformed.length) {
    say("APPLY refused: these ONLY_IDS entries are not outbox row ids (uuid):");
    for (const m of malformed) say(`  - ${JSON.stringify(m)}`);
    say("Copy the id column from the plan above. Nothing was written.");
    process.exit(0);
  }

  // ── the plan: every pending row, with the evidence for who caused it ──────
  const pending = await pg`
    SELECT o.id, o.op, o.doc_type, o.doc_no, o.created_at, o.created_by,
           u.name AS who, o.attempts, o.last_error
    FROM scm.autocount_outbox o
    LEFT JOIN public.users u ON u.id = o.created_by
    WHERE o.status = 'pending' AND o.company_id = ${COMPANY}
    ORDER BY o.created_at, o.doc_no`;

  say(`=== PENDING ROWS, company ${COMPANY} — ${pending.length} ===`);
  say("  Attribution is EVIDENCE, not a verdict: created_by is stamped from the");
  say("  acting Houzs user at enqueue. NULL means nobody was attributed — the");
  say("  cron and the requeue tool also leave it NULL — so NULL is UNATTRIBUTED,");
  say("  never 'a repair'. Decide from the provenance report, then name ids.");
  say();
  for (const r of pending) {
    say(`  ${r.id}  ${r.created_at.toISOString()}  ${r.op.padEnd(10)} ${r.doc_type} ${String(r.doc_no).padEnd(18)} `
      + `by=${r.created_by ?? "NULL"}${r.who ? `(${r.who})` : ""}`);
  }
  say();
  const named = pending.filter((r) => r.created_by != null).length;
  say(`  carrying a named user (NEVER ours to cancel): ${named}`);
  say(`  unattributed                                : ${pending.length - named}`);
  say();

  if (MODE !== "apply") {
    say("PLAN ONLY — nothing was written.");
    say(`To cancel, pass MODE=apply, CONFIRM="${CONFIRM_PHRASE}" and ONLY_IDS=<ids from this list>.`);
    process.exit(0);
  }

  // ── apply: re-read the named ids and refuse the batch on any surprise ─────
  const rows = await pg`
    SELECT id, status, company_id, created_by, doc_no, op
    FROM scm.autocount_outbox
    WHERE id = ANY(${ONLY_IDS}::uuid[])`;

  const found = new Map(rows.map((r) => [r.id, r]));
  const problems = [];
  for (const id of ONLY_IDS) {
    const r = found.get(id);
    if (!r) { problems.push(`${id}: no such outbox row`); continue; }
    if (r.status !== "pending") problems.push(`${id} (${r.doc_no}): status is '${r.status}', not 'pending' — it has already drained or been cancelled`);
    if (Number(r.company_id) !== COMPANY) problems.push(`${id} (${r.doc_no}): company ${r.company_id}, not ${COMPANY}`);
    if (r.created_by != null) problems.push(`${id} (${r.doc_no}): created_by=${r.created_by} — a named person caused this row, it is not ours to cancel`);
  }
  if (problems.length) {
    say("APPLY REFUSED — the batch is not what the plan described:");
    for (const p of problems) say(`  - ${p}`);
    say();
    say("Nothing was written. Re-run the plan, review it, and pass the ids again.");
    process.exit(0);
  }

  const updated = await pg`
    UPDATE scm.autocount_outbox
       SET status = 'skipped',
           last_error = ${REASON},
           updated_at = now()
     WHERE id = ANY(${ONLY_IDS}::uuid[])
       AND status = 'pending'
       AND company_id = ${COMPANY}
       AND created_by IS NULL
    RETURNING id, doc_no, op`;
  say(`=== CANCELLED ${updated.length} of ${ONLY_IDS.length} named row(s) ===`);
  for (const r of updated) say(`  ${r.doc_no}  ${r.op}  ${r.id}`);
  say();

  /* VERIFY ON A FRESH CONNECTION, asserting the SHAPE. A row count is not a
     shape: it would read 'ok' while the status said something else entirely. */
  await pg.end({ timeout: 5 });
  const check = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    const after = await check`
      SELECT id, status, last_error, created_by
      FROM scm.autocount_outbox
      WHERE id = ANY(${ONLY_IDS}::uuid[])`;
    const bad = after.filter((r) => r.status !== "skipped" || r.last_error !== REASON || r.created_by != null);
    say("=== VERIFY (fresh connection) ===");
    say(`  rows re-read      : ${after.length} of ${ONLY_IDS.length}`);
    say(`  status='skipped'  : ${after.filter((r) => r.status === "skipped").length}`);
    say(`  reason recorded   : ${after.filter((r) => r.last_error === REASON).length}`);
    if (bad.length) {
      say(`  NOT AS EXPECTED   : ${bad.length}`);
      for (const b of bad) say(`    ${b.id} status=${b.status} created_by=${b.created_by ?? "NULL"}`);
      exitCode = 1;
    } else {
      say("  every named row is cancelled, carries the reason, and still exists (audit trail kept).");
    }
  } finally {
    await check.end({ timeout: 5 });
  }
  process.exit(exitCode);
} catch (e) {
  console.error("Database unreachable or query failed:", e.message);
  process.exit(1);
} finally {
  try { await pg.end({ timeout: 5 }); } catch { /* already closed on the apply path */ }
}
