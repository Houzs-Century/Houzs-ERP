#!/usr/bin/env node
// ---------------------------------------------------------------------------
// repair-repair-return-received.mjs — give back the receipts a REPAIR purchase
// return wrongly consumed, and recount their PO lines.
//
// THE DAMAGE (B1, 16 Oct 2026). 2990-PRT-2610-001 (REPAIR, POSTED 5 Oct) sent
// XAMMAR-2A(RHF) to HOOKKA for corner cushioning. The goods moved into KL
// SERVICE and stay on the books, but adjustGrnReturnedQty counted the line as
// returned, so 2990-PO-2607-018 read received 0 of 1 and listed the same unit as
// incoming again. HC-PRT-2610-001 has the same shape on Houzs. The code now
// counts CREDIT returns only; this repairs the rows written before that.
//
// THE REPAIR. lib/repair-return-recount.mjs decides: each GRN line on a live
// REPAIR return gets returned_qty = its CREDIT-only recount, then every touched
// PO line gets recomputePoReceived's recount and its PO status is re-derived
// (lib/po-received-recount.mjs). lib/po-received-recount-sql.mjs writes the PO
// side and requests the SO allocation re-walk, as repair-hc0106 does.
//
// ERP ONLY. Nothing is queued to AutoCount.
//
// MODE=plan (default) prints every change and writes nothing.
// MODE=apply + CONFIRM="RECOUNT REPAIR RETURN RECEIPTS" writes in one
// transaction, then re-reads on a fresh connection. COMPANY_ID is required.
//
//   COMPANY_ID=2 npx tsx scripts/repair-repair-return-received.mjs
//   COMPANY_ID=2 MODE=apply CONFIRM="RECOUNT REPAIR RETURN RECEIPTS" npx tsx scripts/repair-repair-return-received.mjs
//
// RE-RUN: inert. A corrected line equals its recount, so a second run selects
// nothing and exits "Nothing to repair".
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { planPoStatuses } from "./lib/po-received-recount.mjs";
import { readPoLines, writeRepair } from "./lib/po-received-recount-sql.mjs";
import { planPoReceived, planReturnedQty } from "./lib/repair-return-recount.mjs";

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "RECOUNT REPAIR RETURN RECEIPTS";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM=${JSON.stringify(CONFIRM_PHRASE)}. Aborting.`);
  process.exit(2);
}
const COMPANY_ID = Number(process.env.COMPANY_ID);
if (!process.env.COMPANY_ID || !Number.isInteger(COMPANY_ID)) {
  console.error(`COMPANY_ID is required (an integer), got ${process.env.COMPANY_ID ?? "(unset)"}. Aborting.`);
  process.exit(2);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set. Aborting.");
  process.exit(1);
}

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const sql = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

/** GRN lines on a live REPAIR return, every return line on them, and every
 *  PO line + GRN line those receipts count toward. */
async function readState(db) {
  const grnLines = await db`
    SELECT gi.id::text AS "grnItemId", gi.purchase_order_item_id::text AS "poItemId",
           g.grn_number AS "grnNumber", g.status::text AS "grnStatus", gi.item_code AS "itemCode",
           COALESCE(gi.qty_accepted, 0)::float8 AS "qtyAccepted",
           COALESCE(gi.returned_qty, 0)::float8 AS "returnedQty"
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
     WHERE g.company_id = ${COMPANY_ID}
       AND EXISTS (SELECT 1 FROM scm.purchase_return_items pri
                     JOIN scm.purchase_returns pr ON pr.id = pri.purchase_return_id
                    WHERE pri.grn_item_id = gi.id AND pr.company_id = ${COMPANY_ID}
                      AND pr.kind::text = 'REPAIR' AND pr.status::text <> 'CANCELLED')`;
  const gIds = grnLines.map((g) => g.grnItemId);
  const prLines = gIds.length === 0 ? [] : await db`
    SELECT pri.grn_item_id::text AS "grnItemId", pri.qty_returned::float8 AS "qtyReturned",
           pr.kind::text AS "prKind", pr.status::text AS "prStatus"
      FROM scm.purchase_return_items pri JOIN scm.purchase_returns pr ON pr.id = pri.purchase_return_id
     WHERE pri.grn_item_id = ANY(${gIds}::uuid[]) AND pr.company_id = ${COMPANY_ID}`;
  const poItemIds = [...new Set(grnLines.map((g) => g.poItemId).filter(Boolean))];
  const poLines = poItemIds.length === 0 ? [] : await db`
    SELECT poi.id::text AS "poItemId", po.id::text AS "poId", po.po_number AS "poNumber",
           po.status::text AS "poStatus", po.linked_ac_docno AS "linkedAcDocno",
           poi.item_code AS "itemCode", poi.qty::float8 AS qty,
           COALESCE(poi.received_qty, 0)::float8 AS "receivedQty"
      FROM scm.purchase_order_items poi JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.id = ANY(${poItemIds}::uuid[]) AND po.company_id = ${COMPANY_ID}`;
  const allGrnLines = poItemIds.length === 0 ? [] : await db`
    SELECT gi.id::text AS "grnItemId", gi.purchase_order_item_id::text AS "poItemId",
           g.status::text AS "grnStatus", COALESCE(gi.qty_accepted, 0)::float8 AS "qtyAccepted",
           COALESCE(gi.returned_qty, 0)::float8 AS "returnedQty"
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
     WHERE gi.purchase_order_item_id = ANY(${poItemIds}::uuid[]) AND g.company_id = ${COMPANY_ID}`;
  return { grnLines, prLines, poLines, allGrnLines };
}

const plan = (s) => {
  const grnFixes = planReturnedQty(s.grnLines, s.prLines);
  return { grnFixes, poFixes: planPoReceived(s.poLines, s.allGrnLines, grnFixes) };
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"} company=${COMPANY_ID}`);
  const state = await readState(sql);
  log(`GRN lines on a live REPAIR return: ${state.grnLines.length}`);
  const { grnFixes, poFixes } = plan(state);
  if (grnFixes.length === 0 && poFixes.length === 0) {
    log("Nothing to repair.");
    await sql.end({ timeout: 5 });
    return;
  }
  const poIds = [...new Set(poFixes.map((f) => f.poId))];
  const poPlan = planPoStatuses(poFixes, await readPoLines(sql, COMPANY_ID, poIds));

  log(`\n=== ${grnFixes.length} GRN LINE(S) ===`);
  for (const f of grnFixes) log(`  ${f.grnNumber}  ${f.itemCode}  returned_qty ${f.returnedQty} -> ${f.newReturnedQty}  (accepted ${f.qtyAccepted})`);
  log(`=== ${poFixes.length} PO LINE(S) ===`);
  for (const f of poFixes) log(`  ${f.poNumber}  ${f.itemCode}  received_qty ${f.receivedQty} -> ${f.newReceivedQty}  (qty ${f.qty})`);
  for (const p of poPlan) log(`  ${poFixes.find((f) => f.poId === p.poId).poNumber} status ${p.from} -> ${p.to ?? `${p.from} (not re-derived)`}`);

  if (!APPLY) {
    log(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  const token = randomUUID();
  await sql.begin(async (tx) => {
    for (const f of grnFixes) {
      const back = await tx`
        UPDATE scm.grn_items SET returned_qty = ${f.newReturnedQty}
         WHERE id = ${f.grnItemId}::uuid AND COALESCE(returned_qty, 0) = ${f.returnedQty}
         RETURNING id`;
      if (back.length !== 1) throw new Error(`${f.grnNumber} ${f.itemCode} changed since it was read; nothing written`);
    }
    await writeRepair(tx, COMPANY_ID, poFixes, poPlan, token, "B1: REPAIR return no longer consumes its receipt");
  });
  log(`written: ${grnFixes.length} GRN line(s), ${poFixes.length} PO line(s), ${poPlan.filter((p) => p.to).length} PO status(es), allocation re-walk requested (token ${token}).`);
  await sql.end({ timeout: 5 });

  const check = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  let failed = false;
  try {
    log("\n=== VERIFIED ON A FRESH CONNECTION ===");
    const again = await readState(check);
    const left = plan(again);
    if (left.grnFixes.length || left.poFixes.length) {
      failed = true;
      bad(`still off: ${[...left.grnFixes.map((f) => `${f.grnNumber} ${f.itemCode}`), ...left.poFixes.map((f) => `${f.poNumber} ${f.itemCode}`)].join("; ")}`);
    }
    for (const f of poFixes) {
      const row = again.poLines.find((p) => p.poItemId === f.poItemId);
      const ok = row && row.receivedQty === f.newReceivedQty;
      if (!ok) failed = true;
      log(`  ${ok ? "OK " : "BAD"} ${f.poNumber} ${f.itemCode} received_qty reads ${row?.receivedQty ?? "(missing)"} (want ${f.newReceivedQty})`);
    }
    const posAfter = await readPoLines(check, COMPANY_ID, poIds);
    for (const p of poPlan) {
      const want = p.to ?? p.from;
      const ok = posAfter.get(p.poId)?.status === want;
      if (!ok) failed = true;
      log(`  ${ok ? "OK " : "BAD"} PO ${p.poId} status reads ${posAfter.get(p.poId)?.status ?? "(missing)"} (want ${want})`);
    }
  } finally {
    await check.end({ timeout: 5 });
  }
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
