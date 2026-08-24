#!/usr/bin/env node
/* Read-only: how many live documents carry ON_HOLD, and can the status they
 * held BEFORE the hold be recovered?
 *
 * WHY THIS RUNS BEFORE THE MIGRATION, in the owner's words (2026-08-22):
 * 「我们的hold是给我们知道一个 order hold这的」 — a hold is a MARKER saying this
 * document is paused, not a step in its life. Today it is written into the
 * `status` column, so holding an IN_PRODUCTION order OVERWRITES the progress,
 * and `Take Off Hold` sends every document back to CONFIRMED regardless of
 * where it actually was (frontend/src/pages/scm-v2/row-menus.ts:92).
 *
 * The fix turns the hold into a FLAG beside the status. That needs a backfill,
 * and a backfill needs to know two things this script measures and nothing else
 * in the repo can answer:
 *
 *   1. HOW MANY rows are sitting on ON_HOLD right now. If the answer is zero
 *      the backfill is a no-op and the migration carries no risk at all.
 *   2. Whether scm.entity_audit_log recorded the transition INTO ON_HOLD, which
 *      is the only place the pre-hold status still exists. If it did not, a
 *      held row cannot be restored to the truth and the fallback has to be
 *      chosen deliberately and written down, not guessed at apply time.
 *
 * It also counts Sales Orders on SHIPPED, because the owner asked for SHIPPED
 * to be merged into DELIVERED on the Sales Order (2026-08-22) and that merge
 * moves those rows.
 *
 * NOT A CLAIM ABOUT THE ENUM. `ON_HOLD` stays a legal label in every enum that
 * has it for ever — Postgres cannot DROP VALUE. This measures ROWS.
 *
 * Writes nothing. SELECT only. Exit 0 for every legitimate answer; the output
 * IS the answer. A missing table or column is reported as a FINDING and the
 * run carries on, so a verdict is never computed over a table that failed to
 * read.
 *
 * RE-RUN: safe and idempotent; it is a SELECT. */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The five documents the hold marker will live on. The Delivery Order has NO
   ON_HOLD label today — the owner asked for one on 2026-08-21 (「再加到一个
   Hold」) and it was missed while PO/GRN/PI got theirs. It is listed here so its
   status spread is measured alongside the others rather than assumed. */
const DOCS = [
  ["mfg_sales_orders",  "Sales Order"],
  ["purchase_orders",   "Purchase Order"],
  ["grns",              "Goods Received"],
  ["purchase_invoices", "Purchase Invoice"],
  ["delivery_orders",   "Delivery Order"],
];

async function main() {
  note("=== check-hold-and-shipped-rows (read-only) ===");

  let heldTotal = 0;
  const heldByTable = new Map();

  for (const [table, label] of DOCS) {
    let rows;
    try {
      rows = await sql`
        SELECT status::text AS status, company_id, COUNT(*)::int AS n
          FROM ${sql("scm")}.${sql(table)}
         GROUP BY 1, 2
         ORDER BY 1, 2`;
    } catch (e) {
      note(`\n${label} (scm.${table}): COULD NOT READ — ${e.message}`);
      continue;
    }

    const total = rows.reduce((a, r) => a + r.n, 0);
    const held = rows.filter((r) => r.status === "ON_HOLD").reduce((a, r) => a + r.n, 0);
    heldTotal += held;
    heldByTable.set(table, { held, label });

    note(`\n${label} (scm.${table}) — ${total} rows, ${held} ON_HOLD`);
    for (const r of rows) {
      const flag = r.status === "ON_HOLD" ? "  <== HOLD" : "";
      note(`    company ${r.company_id}  ${String(r.status).padEnd(20)} ${String(r.n).padStart(6)}${flag}`);
    }
  }

  /* The Sales Order SHIPPED -> DELIVERED merge the owner asked for. */
  note("\n=== Sales Orders on SHIPPED (the tab being merged into Delivered) ===");
  try {
    const shipped = await sql`
      SELECT company_id, COUNT(*)::int AS n
        FROM scm.mfg_sales_orders
       WHERE status::text = 'SHIPPED'
       GROUP BY 1 ORDER BY 1`;
    if (!shipped.length) note("    none — the merge moves no rows");
    for (const r of shipped) note(`    company ${r.company_id}: ${r.n}`);
  } catch (e) {
    note(`    COULD NOT READ — ${e.message}`);
  }

  /* Can a held row be put back where it was? The audit log is the only record
     of the status it left. Zero held rows makes this moot, and saying so beats
     an empty section that reads like a failure. */
  note("\n=== Can the pre-hold status be recovered? ===");
  if (heldTotal === 0) {
    note("    MOOT — nothing is on hold, so nothing needs restoring.");
  } else {
    for (const [table, { held, label }] of heldByTable) {
      if (!held) continue;
      try {
        /* COUNTS ONLY, GROUPED BY THE RECOVERED STATUS — never document numbers.
           This repository is PUBLIC and so is every Actions log it produces, so
           a probe prints how many, not which. The grouping carries everything
           the backfill needs: it says what to restore each held row TO, and how
           many have no audit row and therefore need a decision. */
        const rows = await sql`
          SELECT COALESCE((
                   SELECT a.old_values->>'status'
                     FROM scm.entity_audit_log a
                    WHERE a.entity_id::text = d.id::text
                      AND a.new_values->>'status' = 'ON_HOLD'
                    ORDER BY a.created_at DESC
                    LIMIT 1), 'UNKNOWN (no audit row)') AS status_before,
                 COUNT(*)::int AS n
            FROM ${sql("scm")}.${sql(table)} d
           WHERE d.status::text = 'ON_HOLD'
           GROUP BY 1
           ORDER BY 2 DESC`;
        const known = rows.filter((r) => !r.status_before.startsWith("UNKNOWN"))
                          .reduce((a, r) => a + r.n, 0);
        note(`\n  ${label}: ${known} of ${held} held rows have a recoverable pre-hold status`);
        for (const r of rows) note(`    restore to ${String(r.status_before).padEnd(28)} ${String(r.n).padStart(5)}`);
      } catch (e) {
        note(`  ${label}: audit lookup failed — ${e.message}`);
      }
    }
  }

  note("\n=== VERDICT ===");
  note(heldTotal === 0
    ? "  ZERO documents are on hold. Turning the hold into a flag moves NO existing"
      + " row: the migration adds columns that start false, and no status needs"
      + " rewriting. The pre-hold-status recovery problem does not arise."
    : `  ${heldTotal} document(s) sit on ON_HOLD and will need their real status put`
      + ` back. Read the per-document lines above BEFORE choosing a fallback for any`
      + ` row marked UNKNOWN — a guessed status is a wrong status.`);

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
