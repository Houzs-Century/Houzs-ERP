#!/usr/bin/env node
// READ-ONLY. What has the 2990 SO mirror been DECLINING, and when did it last
// try — the durable half of import-once (#2515, mig 0311).
//
// WHY THIS EXISTS. The receiver stopped applying re-deliveries of orders Houzs
// already holds, and refuses a 2990-side delete of one. Both answer 200 and
// write a console line. A console line cannot be read after the fact, and that
// turns the obvious acceptance test into one that cannot fail: with 2990's
// outbox idle (pending=0, last delivery 2026-08-19T08:42:39Z, measured by
// mirror-drift-sentinel.mjs), "I edited a 2990 order and the edit survived" is
// equally true of a mirror that held the line and a mirror that sent nothing.
//
// So this prints the one fact that separates them:
//
//   an edit survived AND last_seen moved  -> import-once HELD. Proof.
//   an edit survived and nothing moved    -> the mirror was quiet. The test
//                                            proved nothing, which is an honest
//                                            answer and not a pass.
//
// IT ASSERTS THE SHAPE, NOT A COUNT, and that is deliberate. 0311 is a CREATE
// TABLE IF NOT EXISTS, so a pre-existing table of the same name and a DIFFERENT
// shape would be skipped in silence and the receiver's INSERT would fail
// against it forever. A row count cannot see that — an empty table and a wrong
// table both read as zero. The column check below is the migration's missing
// production verification, which is why this is the first thing to run after it
// deploys.
//
// EXIT CODES. 0 for every legitimate answer INCLUDING "nothing declined yet" —
// a quiet mirror is not a fault and a red job reads as "the check broke".
// Non-zero only when the check could not be performed: no credential, the table
// absent (0311 not deployed), or the shape wrong.
//
// RE-RUN: inert. One SELECT, no writes, no DDL.
//
// Usage: node backend/scripts/check-so-mirror-skips.mjs
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("FAIL: no DATABASE_URL. This check does not report health it did not measure.");
  process.exit(1);
}

/* The shape 0311 creates and so-mirror.ts binds against. Names only: the
   receiver INSERTs three columns and reads none, so a widened type is harmless
   while a missing or renamed column is fatal and silent. */
const REQUIRED_COLUMNS = ["company_id", "doc_no", "action", "hits", "first_seen", "last_seen"];

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
let exitCode = 0;

try {
  const cols = await pg`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'so_mirror_skips'`;

  if (cols.length === 0) {
    console.error(
      "FAIL: scm.so_mirror_skips does not exist. Migration 0311 has not been applied to this database, " +
      "so every declined delivery is being recorded nowhere. Check the Deploy run that should have applied it.",
    );
    process.exit(1);
  }

  const present = new Set(cols.map((c) => c.column_name));
  const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
  if (missing.length > 0) {
    console.error(
      `FAIL: scm.so_mirror_skips exists but is the WRONG SHAPE — missing ${missing.join(", ")}. ` +
      "0311 is CREATE TABLE IF NOT EXISTS, so it skipped a table that was already there under this name. " +
      "The receiver's INSERT is failing against it (logged, never fatal), and this ledger is empty for a " +
      "reason that has nothing to do with the mirror being quiet.",
    );
    process.exit(1);
  }
  console.log(`shape OK — scm.so_mirror_skips carries all ${REQUIRED_COLUMNS.length} expected columns.`);

  const rows = await pg`
    SELECT doc_no, action, hits,
           to_char(first_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS first_utc,
           to_char(last_seen  AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS last_utc,
           round(EXTRACT(EPOCH FROM (now() - last_seen)) / 60)::int     AS mins_ago
      FROM scm.so_mirror_skips
     ORDER BY last_seen DESC
     LIMIT 50`;

  const [{ docs, total }] = await pg`
    SELECT count(DISTINCT doc_no)::int AS docs, COALESCE(sum(hits), 0)::bigint AS total
      FROM scm.so_mirror_skips`;

  console.log(`\ndeclined deliveries: ${total} across ${docs} document(s)\n`);

  if (rows.length === 0) {
    console.log("Nothing declined yet. Either 2990 has re-delivered nothing since 0311 deployed, or it has");
    console.log("only ever sent orders Houzs did not already hold. Cross-check with the Mirror drift sentinel:");
    console.log("a lastDelivery that has not moved either says the queue is idle, which is the boring answer.");
  } else {
    console.log("  last (UTC)         age     hits  action             doc_no");
    for (const r of rows) {
      console.log(
        `  ${r.last_utc}   ${String(r.mins_ago + "m").padStart(6)}  ${String(r.hits).padStart(5)}  ` +
        `${String(r.action).padEnd(17)}  ${r.doc_no}`,
      );
    }
    console.log("\nREADING IT: `age` is what an acceptance test turns on. An edit that survived while the");
    console.log("matching doc_no's age is SMALLER than the wait you gave it means a delivery was offered and");
    console.log("declined during the window — that is the proof. A large age means the mirror was quiet.");
  }
} catch (e) {
  console.error("FAIL: check error -", e.message);
  exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}

process.exit(exitCode);
