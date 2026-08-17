#!/usr/bin/env node
/* ALREADY RUN — DO NOT RE-RUN.
   
   Written for a one-shot data backfill and executed in 2026-07. It is kept for the record of
   what was done to production, not as a tool.
   
   It gave every ACTIVE Sales-department user a sales_reps row. Running it again on a roster that has since changed would re-create rows for people who were deliberately removed.
   
   Nothing in this repository reaches it: no npm script, no workflow, no doc,
   no import. That is deliberate now — it used to be an accident, and an
   unreferenced script whose NAME still reads as runnable is an invitation. */
/**
 * One-shot backfill: give every ACTIVE Sales-department user a sales_reps row.
 *
 * WHY
 *   The Sales Team roster (sales_reps) is what the PMS "Sales Attending" picker
 *   and the SCM salesperson lists read. Historically a rep row was auto-created
 *   ONLY when a user's department CHANGED to Sales (syncSalesRepFromUser fired
 *   from the users PATCH hook). Users invited straight into a Sales department
 *   never triggered that path, so they had no rep and the picker showed
 *   "No Sales Persons found". The forward fix now syncs on invite/create too,
 *   but existing Sales staff created before that fix still have no rep — this
 *   script converges them.
 *
 * WHAT (mirrors syncSalesRepFromUser's create branch, one row at a time)
 *   For each ACTIVE user whose PRIMARY department name contains "sales"
 *   (case-insensitive) and who has NO sales_reps row (by user_id):
 *     1. allocate the next SR-NNN code (max existing SR-% code + 1)
 *     2. INSERT sales_reps (code, name, email, user_id, status='active')
 *     3. INSERT a sales_team_activity 'created' audit row
 *
 * SAFETY / STAGING-FIRST (owner rule: data ops run on STAGING first)
 *   - Prints the target DB host up front so you can confirm staging vs prod.
 *   - DRY-RUN by default: lists the exact rows it WOULD create and exits
 *     without writing. Pass --commit to actually insert.
 *   - Idempotent + additive: it only touches users with no existing rep, so
 *     re-running (on staging, then prod) never duplicates a rep and never
 *     unarchives or edits an existing one.
 *   - Scope guard: ACTIVE + department-contains-"sales" ONLY. Non-Sales users
 *     and disabled/invited users are never given a rep here.
 *
 * USAGE
 *   node backend/scripts/backfill-sales-reps.mjs            # dry-run (default)
 *   node backend/scripts/backfill-sales-reps.mjs --commit   # actually write
 *
 * Reads DATABASE_URL from .dev.vars (same convention as the other scripts).
 * Point .dev.vars at STAGING first, verify, then re-point at prod and re-run.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const COMMIT = process.argv.includes("--commit");

const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
if (!url) {
  console.error("Could not read DATABASE_URL from .dev.vars");
  process.exit(1);
}
// Surface the host (no credentials) so the operator can confirm the target DB
// before any write — staging-first is only meaningful if you can SEE the target.
let host = "unknown";
try {
  host = new URL(url).host;
} catch {
  /* leave as unknown */
}
console.log(`Target DB host: ${host}`);
console.log(`Mode: ${COMMIT ? "COMMIT (will write)" : "DRY-RUN (no writes)"}\n`);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, idle_timeout: 5 });

try {
  // Active Sales-department users with no existing rep (by user_id link).
  // Department match mirrors syncSalesRepFromUser: name CONTAINS 'sales'
  // (prod uses "Sales Department", not the seeded canonical "Sales").
  const missing = await sql`
    SELECT u.id, u.name, u.email
      FROM users u
      JOIN departments d ON d.id = u.department_id
 LEFT JOIN sales_reps r ON r.user_id = u.id
     WHERE u.status = 'active'
       AND LOWER(d.name) LIKE '%sales%'
       AND r.id IS NULL
     ORDER BY u.id`;

  if (missing.length === 0) {
    console.log("No drift — every active Sales user already has a rep. Nothing to do.");
    await sql.end({ timeout: 3 }).catch(() => {});
    process.exit(0);
  }

  // Next SR-NNN number — same rule as nextSalesRepCode: highest SR-% code + 1.
  const maxRow = await sql`
    SELECT code FROM sales_reps
     WHERE code LIKE 'SR-%'
     ORDER BY code DESC
     LIMIT 1`;
  let nextNum = 1;
  if (maxRow[0]?.code) {
    const n = parseInt(maxRow[0].code.slice(3), 10);
    if (Number.isFinite(n)) nextNum = n + 1;
  }

  console.log(`Found ${missing.length} active Sales user(s) with no rep:\n`);
  const planned = missing.map((u) => {
    const code = `SR-${String(nextNum++).padStart(3, "0")}`;
    const name = u.name || u.email;
    console.log(`  ${code}  user_id=${u.id}  ${name} <${u.email ?? ""}>`);
    return { userId: u.id, code, name, email: u.email ?? null };
  });

  if (!COMMIT) {
    console.log(`\nDRY-RUN — no rows written. Re-run with --commit to create these ${planned.length} rep(s).`);
    await sql.end({ timeout: 3 }).catch(() => {});
    process.exit(0);
  }

  console.log("\nWriting...");
  let created = 0;
  for (const p of planned) {
    // One rep + one audit row inside a txn, mirroring syncSalesRepFromUser's
    // create branch. The unique(user_id) constraint is the final backstop: a
    // concurrent create would raise rather than duplicate.
    await sql.begin(async (tx) => {
      const ins = await tx`
        INSERT INTO sales_reps (code, name, email, user_id, status)
        VALUES (${p.code}, ${p.name}, ${p.email}, ${p.userId}, 'active')
        RETURNING id`;
      const repId = ins[0].id;
      await tx`
        INSERT INTO sales_team_activity (rep_id, action, from_value, to_value, note, user_id)
        VALUES (${repId}, 'created', NULL, ${p.code},
                'Backfilled from Team (active user already in Sales)', NULL)`;
    });
    created++;
  }
  console.log(`\nDone. Created ${created} sales_reps row(s).`);
} finally {
  await sql.end({ timeout: 3 }).catch(() => {});
}
process.exitCode = 0;
