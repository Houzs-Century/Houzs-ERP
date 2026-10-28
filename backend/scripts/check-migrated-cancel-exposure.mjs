#!/usr/bin/env node
/**
 * MIGRATED CANCEL EXPOSURE — has a document that never posted stock already had
 * its stock un-posted?
 *
 * WHY THIS EXISTS. `PATCH /grns/:id/cancel` built its reversal from the GRN's
 * LINES rather than from the movements the document actually wrote, and never
 * read `migrated_no_stock` (migration 0276). The 320 migrated goods receipts
 * carry no movements on purpose — on-hand entered the ERP once through the
 * AutoCount balance snapshot — so cancelling one wrote a reversing OUT for
 * units it never brought in. `resyncInventoryForDo` had the same shape on the
 * delivery side, reachable by an ordinary line edit rather than a cancel.
 *
 * Both are guarded now. THIS SCRIPT ANSWERS THE OTHER HALF: whether any of it
 * already happened, before the guard existed. That fact lives only in
 * production, and the owner is not a database console.
 *
 * WHAT "ALREADY HAPPENED" LOOKS LIKE, and why two questions are asked and not
 * one. A cancel leaves an AUDIT row whether or not the reversal wrote; the
 * reversal leaves a MOVEMENT row. So:
 *
 *   movements  > 0  ->  STOCK IS WRONG TODAY. This is the finding.
 *   cancelled  > 0, movements 0  ->  a cancel happened and the reversal did not
 *                    write (a failed movement insert, or a document with no
 *                    stock lines). Paperwork moved, stock did not. Worth
 *                    naming, not an emergency.
 *   both 0     ->  nothing to repair. The guard is preventive.
 *
 * A zero here is a real answer, not a failure to measure: Q2 states the
 * denominator every time, so "0 movements" cannot be confused with "0 documents
 * looked at".
 *
 * READ-ONLY. One statement per question. No writes, no DDL, no transaction.
 * Exit 0 for every legitimate answer — including the bad one — because a red
 * job reads as "the check broke" and the ANSWER is the output. Non-zero only
 * when the database is unreachable or a statement errors.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     default 1 (Houzs Century / AED_HOUZS)
 *
 * RE-RUN: read-only and idempotent. A second run writes nothing and reports the
 * same numbers unless production changed underneath it.
 */
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARNING: ${m}`);
const say = (m) => console.log(m);
const rule = (t) => say(`\n═══════════ ${t} ═══════════`);

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/** `{POSTED: 318, CANCELLED: 2}` rendered as a stable, readable line. */
const hist = (rows) => rows.length
  ? rows.map((r) => `${r.status} ${r.n}`).join("   ")
  : "(no rows)";

/** Does scm.<table> have the column? Migration 0294 added it to the two invoice
 *  tables AFTER 0276 did the two stock documents, so a database between the two
 *  is a legitimate state and must report "not applicable", never a false zero. */
async function hasColumn(table, column) {
  const [row] = await sql`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table} AND column_name = ${column}`;
  return row.n > 0;
}

async function main() {
  say(`MIGRATED CANCEL EXPOSURE — company ${CO}, read-only. ${new Date().toISOString()}`);

  // ── Q1: the population ─────────────────────────────────────────────────────
  rule("Q1 — how many migrated documents are there, and what status they are in");

  const grnStatus = await sql`
    SELECT status, COUNT(*)::int AS n FROM scm.grns
     WHERE company_id = ${CO} AND migrated_no_stock = true
     GROUP BY status ORDER BY status`;
  const grnTotal = grnStatus.reduce((a, r) => a + r.n, 0);
  const grnCancelled = grnStatus.filter((r) => String(r.status).toUpperCase() === "CANCELLED")
    .reduce((a, r) => a + r.n, 0);
  say(`goods receipts (scm.grns, migrated_no_stock = true): ${grnTotal}`);
  say(`  by status: ${hist(grnStatus)}`);

  const doStatus = await sql`
    SELECT status, COUNT(*)::int AS n FROM scm.delivery_orders
     WHERE company_id = ${CO} AND migrated_no_stock = true
     GROUP BY status ORDER BY status`;
  const doTotal = doStatus.reduce((a, r) => a + r.n, 0);
  const doCancelled = doStatus.filter((r) => String(r.status).toUpperCase() === "CANCELLED")
    .reduce((a, r) => a + r.n, 0);
  say(`delivery orders (scm.delivery_orders, migrated_no_stock = true): ${doTotal}`);
  say(`  by status: ${hist(doStatus)}`);

  notice(`POPULATION — ${grnTotal} migrated goods receipts (${grnCancelled} CANCELLED), ${doTotal} migrated delivery orders (${doCancelled} CANCELLED), company ${CO}`);

  // ── Q2: the movements — the question that decides whether stock is wrong ───
  rule("Q2 — is there any inventory movement behind a migrated document?");
  say("A migrated document is supposed to have NONE. A row here is either the");
  say("cancel/edit defect having fired, or the migrated_no_stock claim being false.");

  const grnMv = await sql`
    SELECT COALESCE(m.movement_type::text, '?') AS status, COUNT(*)::int AS n,
           COALESCE(SUM(ABS(m.qty)), 0)::float8 AS units
      FROM scm.inventory_movements m
      JOIN scm.grns g ON g.id::text = m.source_doc_id::text
     WHERE m.company_id = ${CO} AND m.source_doc_type = 'GRN'
       AND g.company_id = ${CO} AND g.migrated_no_stock = true
     GROUP BY 1 ORDER BY 1`;
  const grnMvRows = grnMv.reduce((a, r) => a + r.n, 0);
  const grnMvUnits = grnMv.reduce((a, r) => a + Number(r.units), 0);
  say(`movements behind the ${grnTotal} migrated goods receipts: ${grnMvRows} row(s), ${grnMvUnits} units`);
  if (grnMvRows) say(`  by type: ${grnMv.map((r) => `${r.status} ${r.n} (${r.units}u)`).join("   ")}`);

  /* DO movements are asked for BOTH source types on purpose. The first ship
     writes source_doc_type='DO'; every reversal and correction writes
     source_doc_type='ADJUSTMENT' carrying the DO's id (fn_reverse_do_out,
     buildDoReversalRows). Asking only about 'DO' would report a clean book on a
     document that had been reversed. */
  const doMv = await sql`
    SELECT m.source_doc_type || ':' || COALESCE(m.movement_type::text, '?') AS status,
           COUNT(*)::int AS n, COALESCE(SUM(ABS(m.qty)), 0)::float8 AS units
      FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id::text = m.source_doc_id::text
     WHERE m.company_id = ${CO} AND m.source_doc_type IN ('DO', 'ADJUSTMENT')
       AND d.company_id = ${CO} AND d.migrated_no_stock = true
     GROUP BY 1 ORDER BY 1`;
  const doMvRows = doMv.reduce((a, r) => a + r.n, 0);
  const doMvUnits = doMv.reduce((a, r) => a + Number(r.units), 0);
  say(`movements behind the ${doTotal} migrated delivery orders: ${doMvRows} row(s), ${doMvUnits} units`);
  if (doMvRows) say(`  by type: ${doMv.map((r) => `${r.status} ${r.n} (${r.units}u)`).join("   ")}`);

  const dirty = grnMvRows + doMvRows;
  if (dirty === 0) {
    notice(`STOCK — CLEAN. 0 movement rows behind ${grnTotal + doTotal} migrated documents (${grnTotal} receipts + ${doTotal} delivery orders). No phantom movement was ever written; the guard is preventive, not a repair.`);
  } else {
    warn(`STOCK — NOT CLEAN. ${dirty} movement row(s) (${grnMvUnits + doMvUnits} units) sit behind migrated documents that are supposed to have none. On-hand is wrong by that amount unless each row is explained. The named documents are listed below — repair before quoting any stock figure.`);
  }

  // ── Q3: name the documents, so a repair has something to act on ────────────
  rule("Q3 — WHICH documents (only printed when there is something to name)");
  if (grnMvRows) {
    const named = await sql`
      SELECT g.grn_number AS status, COUNT(m.id)::int AS n,
             COALESCE(SUM(ABS(m.qty)), 0)::float8 AS units
        FROM scm.inventory_movements m
        JOIN scm.grns g ON g.id::text = m.source_doc_id::text
       WHERE m.company_id = ${CO} AND m.source_doc_type = 'GRN'
         AND g.company_id = ${CO} AND g.migrated_no_stock = true
       GROUP BY 1 ORDER BY 3 DESC LIMIT 50`;
    say(`goods receipts carrying movements (top ${named.length}):`);
    for (const r of named) say(`   ${r.status}   ${r.n} row(s)   ${r.units} units`);
  } else say("no goods receipt to name.");

  if (doMvRows) {
    const named = await sql`
      SELECT d.do_number AS status, COUNT(m.id)::int AS n,
             COALESCE(SUM(ABS(m.qty)), 0)::float8 AS units
        FROM scm.inventory_movements m
        JOIN scm.delivery_orders d ON d.id::text = m.source_doc_id::text
       WHERE m.company_id = ${CO} AND m.source_doc_type IN ('DO', 'ADJUSTMENT')
         AND d.company_id = ${CO} AND d.migrated_no_stock = true
       GROUP BY 1 ORDER BY 3 DESC LIMIT 50`;
    say(`delivery orders carrying movements (top ${named.length}):`);
    for (const r of named) say(`   ${r.status}   ${r.n} row(s)   ${r.units} units`);
  } else say("no delivery order to name.");

  // ── Q4: the paper trail — a cancel that reversed nothing still leaves one ──
  rule("Q4 — has anyone CANCELLED a migrated document at all?");
  say("Separate from Q2 on purpose: the audit row records the cancel, the movement");
  say("row records the reversal, and the two can disagree in both directions.");

  const cancels = await sql`
    SELECT a.entity_type AS status, COUNT(*)::int AS n
      FROM scm.entity_audit_log a
     WHERE a.action = 'CANCEL'
       AND ((a.entity_type = 'GRN' AND a.entity_id::text IN (
              SELECT g.id::text FROM scm.grns g
               WHERE g.company_id = ${CO} AND g.migrated_no_stock = true))
         OR (a.entity_type = 'DELIVERY_ORDER' AND a.entity_id::text IN (
              SELECT d.id::text FROM scm.delivery_orders d
               WHERE d.company_id = ${CO} AND d.migrated_no_stock = true)))
     GROUP BY 1 ORDER BY 1`;
  const cancelRows = cancels.reduce((a, r) => a + r.n, 0);
  say(`CANCEL audit rows on migrated documents: ${cancelRows}`);
  if (cancelRows) say(`  by entity: ${hist(cancels)}`);
  if (cancelRows === 0 && grnCancelled + doCancelled > 0) {
    say("  NOTE: Q1 shows CANCELLED documents with no CANCEL audit row — those were");
    say("  cancelled by direct SQL, not through the route, which writes no movement.");
  }

  // ── Q5: what the guard is worth, in units ──────────────────────────────────
  rule("Q5 — what the exposure WOULD have been");
  const [{ units: grnAtRisk }] = await sql`
    SELECT COALESCE(SUM(i.qty_accepted), 0)::float8 AS units
      FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true
       AND g.status NOT IN ('CANCELLED', 'DRAFT')`;
  const [{ units: doAtRisk }] = await sql`
    SELECT COALESCE(SUM(di.qty), 0)::float8 AS units
      FROM scm.delivery_order_items di JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE d.company_id = ${CO} AND d.migrated_no_stock = true
       AND d.status <> 'CANCELLED'`;
  notice(`EXPOSURE PREVENTED — cancelling every live migrated goods receipt would have written reversing OUTs for ${grnAtRisk} units; editing one line on every live migrated delivery order would have written OUTs for ${doAtRisk} units. Neither can happen now.`);

  // ── Q6: the invoices, which migration 0294 flags but which post no stock ───
  rule("Q6 — the migrated INVOICES (migration 0294)");
  for (const t of ["purchase_invoices", "sales_invoices"]) {
    if (!(await hasColumn(t, "migrated_no_stock"))) {
      say(`scm.${t}.migrated_no_stock does not exist — migration 0294 is not applied here. Not applicable.`);
      continue;
    }
    const rows = await sql`
      SELECT status, COUNT(*)::int AS n FROM scm.${sql(t)}
       WHERE company_id = ${CO} AND migrated_no_stock = true
       GROUP BY status ORDER BY status`;
    say(`scm.${t}: ${rows.reduce((a, r) => a + r.n, 0)} migrated — ${hist(rows)}`);
  }
  say("Invoices are listed for completeness only. NO invoice route in this codebase");
  say("writes an inventory movement — stock moves on the goods receipt and the");
  say("delivery order — so the flag there is documentation, not a stock guard.");
  say("Reproduce: git grep -ln writeMovements -- backend/src/scm/routes");

  await sql.end();
  say("");
  notice("check-migrated-cancel-exposure: read-only, nothing was written.");
}

main().catch((e) => { console.error(e); process.exit(1); });
