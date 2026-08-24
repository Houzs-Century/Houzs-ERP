#!/usr/bin/env node
/* ALREADY RUN — DO NOT RE-RUN.
   
   Written for a one-shot data sync and executed in 2026-06. It is kept for the record of
   what was done to production, not as a tool.
   
   It brought Sales-department users' sales_reps rows into line. Superseded by whatever maintains that mapping now — find that before re-running this.
   
   Nothing in this repository reaches it: no npm script, no workflow, no doc,
   no import. That is deliberate now — it used to be an accident, and an
   unreferenced script whose NAME still reads as runnable is an invitation. */
/**
 * One-shot: bring every Sales-department user's sales_reps row into the
 * project "Sales Attending" picker.
 *
 * Background (owner: Option A — all Sales-dept members, ignore brand):
 *   The picker source GET /api/projects/sales-rep-options lists reps that
 *   are unarchived, status='active', AND positioned as 'sales_person'.
 *   In prod every Sales-dept user already HAS a rep row (auto-created by
 *   syncSalesRepFromUser at some point) but each is archived_at != NULL
 *   and position_id = NULL, so the picker returns 0 rows.
 *
 *   syncSalesRepFromUser only creates / un-archives — it never sets
 *   position_id. So this script does two things per Sales-dept user:
 *     1) ensure a live rep row (create if missing, else un-archive +
 *        status='active'), mirroring syncSalesRepFromUser's contract;
 *     2) set position_id to the 'sales_person' position when it's NULL,
 *        so the rep clears the picker's slug filter.
 *
 *   The dept match is by NAME containing 'sales' (prod = "Sales
 *   Department"), matching the widened comparison now in
 *   services/salesTeam.ts.
 *
 * Per CLAUDE.md this is a one-shot script (NOT a numbered migration):
 * it's environment-specific data convergence, not a schema change.
 *
 * Idempotent: re-running is a no-op once every Sales-dept user has a
 * live sales_person rep. Reps that the boss has deliberately given a
 * DIFFERENT position (director/manager/etc.) are left untouched —
 * we only fill position_id when it is NULL.
 *
 * Usage (from backend/, reads DATABASE_URL from .dev.vars):
 *   node scripts/sync-sales-dept-reps.mjs [--dry]
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dry = process.argv.slice(2).includes("--dry");
const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="?([^"\n]+)"?/)[1];
const sql = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 1,
  idle_timeout: 5,
  connect_timeout: 15,
});

function now() {
  // Match the app's text-timestamp convention (datetime('now') -> UTC).
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function nextSalesRepCode() {
  const rows = await sql`
    SELECT code FROM sales_reps
     WHERE code LIKE 'SR-%'
     ORDER BY code DESC LIMIT 1`;
  let next = 1;
  if (rows[0]?.code) {
    const n = parseInt(rows[0].code.slice(3), 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `SR-${String(next).padStart(3, "0")}`;
}

try {
  const pos = await sql`SELECT id FROM sales_positions WHERE slug = 'sales_person' LIMIT 1`;
  if (!pos[0]) {
    console.error("FATAL: no sales_positions row with slug='sales_person'. Aborting.");
    process.exit(1);
  }
  const salesPersonId = Number(pos[0].id);
  console.log(`sales_person position id = ${salesPersonId}`);

  const users = await sql`
    SELECT u.id AS uid, u.name, u.email,
           r.id AS rid, r.archived_at, r.status, r.position_id
      FROM users u
      JOIN departments d ON d.id = u.department_id
      LEFT JOIN sales_reps r ON r.user_id = u.id
     WHERE LOWER(d.name) LIKE '%sales%'
     ORDER BY u.id`;

  console.log(`\nSales-department users: ${users.length}`);

  let created = 0, unarchived = 0, posFilled = 0, noop = 0;
  const ts = now();

  for (const u of users) {
    const label = u.name || u.email || `user#${u.uid}`;
    if (!u.rid) {
      // No rep row — create a live sales_person rep.
      const code = await nextSalesRepCode();
      if (dry) {
        console.log(`  [dry] CREATE rep ${code} for ${label} (pos=sales_person)`);
      } else {
        await sql`
          INSERT INTO sales_reps (code, name, email, user_id, status, position_id, created_at, updated_at)
          VALUES (${code}, ${u.name || u.email}, ${u.email || null}, ${u.uid}, 'active', ${salesPersonId}, ${ts}, ${ts})`;
        console.log(`  CREATE rep ${code} for ${label} (pos=sales_person)`);
      }
      created++;
      continue;
    }

    const needsUnarchive = u.archived_at != null || u.status !== "active";
    const needsPos = u.position_id == null;
    if (!needsUnarchive && !needsPos) {
      noop++;
      continue;
    }

    if (dry) {
      const parts = [];
      if (needsUnarchive) parts.push("un-archive+active");
      if (needsPos) parts.push("set pos=sales_person");
      console.log(`  [dry] rep #${u.rid} for ${label}: ${parts.join(", ")}`);
    } else {
      // Only fill position_id when NULL — never overwrite a deliberate
      // director/manager position the boss set in Sales Team.
      await sql`
        UPDATE sales_reps
           SET archived_at = NULL,
               archived_by = NULL,
               status = 'active',
               position_id = COALESCE(position_id, ${salesPersonId}),
               updated_at = ${ts}
         WHERE id = ${u.rid}`;
      const parts = [];
      if (needsUnarchive) parts.push("un-archived");
      if (needsPos) parts.push("pos=sales_person");
      console.log(`  rep #${u.rid} for ${label}: ${parts.join(", ")}`);
    }
    if (needsUnarchive) unarchived++;
    if (needsPos) posFilled++;
  }

  console.log(
    `\n${dry ? "[dry] " : ""}Summary: created=${created} unarchived=${unarchived} pos-filled=${posFilled} unchanged=${noop}`
  );

  if (!dry) {
    const opts = await sql`
      SELECT count(*) AS n
        FROM sales_reps r
        JOIN sales_positions p ON p.id = r.position_id
       WHERE r.archived_at IS NULL AND r.status = 'active' AND p.slug = 'sales_person'`;
    console.log(`sales-rep-options now returns ${opts[0].n} active sales_person rep(s).`);
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 2;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
