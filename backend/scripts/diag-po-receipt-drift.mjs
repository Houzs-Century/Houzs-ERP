#!/usr/bin/env node
// READ-ONLY drift probe: does every PO line's stored received_qty still agree
// with the GRN lines that actually received against it?
//
// WHY THIS EXISTS. On 2026-07-31 an operator opened 2990-PO-2606-024, saw
// "ORD 5 / RCV 3 / BAL 2" on an order whose two GRNs had received all 10 units
// eleven days earlier, and asked why. Eleven POs turned out to be wrong the same
// way: 2990-GRN-2607-011 through -021 (2026-07-14 04:24Z .. 07-22 02:21Z) each
// posted, each put its stock into inventory, and not one moved its PO. The cause
// is structural — postGrnAndRollup flips the GRN to POSTED first and recounts
// second, and the recount cannot throw (a receipt must not un-receive itself), so
// a failure after the flip left a console.error in a log with no retention and
// nothing else. RM 25,518.50 of goods already in the warehouse read as
// outstanding, and those PO lines kept being offered by the convert-to-GRN
// picker, for nine days, in silence.
//
// The recount now records its own failures (GRN audit trail + recountError on the
// response). This probe is the part that does NOT depend on the failing code
// noticing: it compares state against the ledger, so it catches drift from causes
// nobody predicted — including whatever caused the 07-14 window, which was never
// identified.
//
// EXITS NON-ZERO WHEN IT FINDS DRIFT. That is the entire point. A probe that
// only prints is another log nobody reads; the schedule below turns a red run
// into the notification that was missing.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  /* Truth = live GRN lines, netted for returns and clamped at 0 — the exact rule
     recomputePoReceived applies (grns.ts). DRAFT GRNs have committed no receipt,
     CANCELLED ones have had theirs reversed; neither counts. */
  const rows = await db`
    WITH live AS (
      SELECT gi.purchase_order_item_id AS poi_id,
             SUM(GREATEST(0, COALESCE(gi.qty_accepted, 0) - COALESCE(gi.returned_qty, 0))) AS recv
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
      WHERE gi.purchase_order_item_id IS NOT NULL
        AND g.status NOT IN ('CANCELLED', 'DRAFT')
      GROUP BY gi.purchase_order_item_id
    )
    SELECT po.company_id,
           po.po_number,
           po.status::text AS po_status,
           SUM(poi.qty)::int AS ordered,
           SUM(COALESCE(poi.received_qty, 0))::int AS stored_recv,
           SUM(COALESCE(l.recv, 0))::int AS live_recv,
           (CASE WHEN bool_and(COALESCE(l.recv, 0) >= poi.qty) THEN 'RECEIVED'
                 WHEN bool_or(COALESCE(l.recv, 0) > 0) THEN 'PARTIALLY_RECEIVED'
                 ELSE 'SUBMITTED' END) AS should_be,
           po.total_sen
    FROM scm.purchase_order_items poi
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN live l ON l.poi_id = poi.id
    WHERE po.status <> 'CANCELLED'
    GROUP BY po.id, po.company_id, po.po_number, po.status, po.total_sen
    HAVING SUM(COALESCE(poi.received_qty, 0)) <> SUM(COALESCE(l.recv, 0))
    ORDER BY po.company_id, po.po_number`;

  /* Second signal, independent of the first: the recount now leaves a row when it
     fails. A hit here without matching drift above means a failure that later
     self-healed — still worth seeing, because it names the window. */
  let auditRows = [];
  try {
    auditRows = await db`
      SELECT entity_doc_no, created_at, note
      FROM scm.entity_audit_log
      WHERE action = 'RECOUNT_FAILED'
        AND created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC
      LIMIT 50`;
  } catch {
    /* Pre-dates the verb, or the table is unreachable — the drift check above is
       the load-bearing half and has already run. */
  }

  if (auditRows.length > 0) {
    console.log(`=== recount failures recorded in the last 30 days: ${auditRows.length} ===`);
    for (const r of auditRows) {
      console.log(`  ${String(r.created_at ?? "").slice(0, 19)}  ${r.entity_doc_no ?? "(no doc no)"}  ${r.note ?? ""}`);
    }
    console.log("");
  }

  if (rows.length === 0) {
    console.log("=== PO receipt drift: NONE ===");
    console.log("  every PO line's received_qty agrees with its live GRN lines.");
    // A recorded failure that left no drift is a warning, not an alarm: the
    // damage it would have caused is not there. Say so, exit clean.
    if (auditRows.length > 0) {
      console.log("  (recount failures WERE recorded above — they did not leave drift behind.)");
    }
    return 0;
  }

  console.error(`=== PO receipt drift: ${rows.length} purchase order(s) ===`);
  console.error("  received_qty disagrees with the GRN lines that received against it.");
  console.error("");
  let strandedSen = 0;
  for (const r of rows) {
    const wrongStatus = r.po_status !== r.should_be;
    if (wrongStatus && r.should_be === "RECEIVED") strandedSen += Number(r.total_sen ?? 0);
    console.error(
      `  co=${r.company_id}  ${r.po_number}` +
        `  ordered=${r.ordered}  stored=${r.stored_recv}  actual=${r.live_recv}` +
        `  status=${r.po_status}${wrongStatus ? ` -> should be ${r.should_be}` : ""}`,
    );
  }
  console.error("");
  if (strandedSen > 0) {
    console.error(
      `  RM ${(strandedSen / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })} ` +
        "of fully-received POs are still counted as outstanding.",
    );
  }
  console.error("  FIX: re-run the recount. migrations-pg/0230_po_received_qty_backfill.sql is");
  console.error("       convergent and safe to replay as a new migration — it recomputes from");
  console.error("       the ledger rather than hardcoding rows.");
  return 1;
}

let code = 2;
try {
  code = await main();
} catch (e) {
  console.error("probe failed:", e);
  code = 2;
} finally {
  await db.end({ timeout: 5 });
}
process.exit(code);
