#!/usr/bin/env node
// ---------------------------------------------------------------------------
// repair-hc0106-stale-po-received.mjs — take a cancelled GRN's receipt back off
// the PO line it still counts on, and re-walk SO readiness.
//
// THE DAMAGE (HC-0106, 2026-10-15). Sim: HC-GRN-2610-002 is cancelled but
// HC-SO-2609-164 ELEPHANE-(K) still reads READY, so logistics schedule a
// delivery for goods the system never received. A bedframe line is lit by its
// own PO line's received_qty (so-stock-allocation.ts, bound mode), and
// HC-PO-2609-263's ELEPHANE-(K) line still says received 1.
//
// HOW IT GOT THERE (GRN audit trail):
//   10-01 02:06  OCR scan created the GRN POSTED by the missing-status default
//                (PR #4403), no stock IN.
//   10-01 10:40  a line edit on that POSTED GRN recounted the PO line -> 1.
//   10-01 10:54  data repair put the GRN back to DRAFT; nothing recounted.
//   10-05 04:40  cancelled from DRAFT. Before BUG-64 (#4508, 10-07) the DRAFT
//                cancel exit skipped the recount, so received_qty stayed 1.
// The code path is closed; this repairs the rows it left behind.
//
// THE REPAIR. lib/po-received-recount.mjs decides, with recomputePoReceived's
// own rule. A PO line is corrected only when its PO is not an AutoCount cutover
// order, a DRAFT / CANCELLED GRN line points at it, and it reports more than
// its live GRNs received. The PO status is re-derived from its lines, and the
// SO allocation re-walk is requested through the Worker's queue row (the same
// upsert as stock-allocation-queue.ts); the five-minute cron runs it.
//
// ERP ONLY. Nothing is queued to AutoCount.
//
// MODE=plan (default) prints every line it would change and writes nothing.
// MODE=apply + CONFIRM="RECOUNT CANCELLED GRN PO LINES" writes in one
// transaction, then re-reads on a fresh connection. COMPANY_ID is required.
//
//   COMPANY_ID=1 npx tsx scripts/repair-hc0106-stale-po-received.mjs
//   COMPANY_ID=1 MODE=apply CONFIRM="RECOUNT CANCELLED GRN PO LINES" npx tsx scripts/repair-hc0106-stale-po-received.mjs
//
// RE-RUN: inert. A corrected line equals its live recount, so a second run
// selects nothing and exits "Nothing to repair".
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { planStaleReceived, poStatusFromLines } from "./lib/po-received-recount.mjs";

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "RECOUNT CANCELLED GRN PO LINES";
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

/** Every PO line with at least one DRAFT / CANCELLED GRN line, plus all the GRN
 *  lines on those PO lines, plus the SO line each one is bound to. */
async function readState(db) {
  const poLines = await db`
    SELECT poi.id::text AS "poItemId", po.id::text AS "poId", po.po_number AS "poNumber",
           po.status AS "poStatus", po.linked_ac_docno AS "linkedAcDocno",
           poi.item_code AS "itemCode", poi.qty::float8 AS qty,
           COALESCE(poi.received_qty, 0)::float8 AS "receivedQty",
           si.doc_no AS "soDocNo", si.stock_status AS "soStockStatus"
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = poi.so_item_id
     WHERE po.company_id = ${COMPANY_ID}
       AND EXISTS (SELECT 1 FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
                    WHERE gi.purchase_order_item_id = poi.id
                      AND UPPER(COALESCE(g.status, '')) IN ('DRAFT', 'CANCELLED'))`;
  const ids = poLines.map((p) => p.poItemId);
  const grnLines = ids.length === 0 ? [] : await db`
    SELECT gi.purchase_order_item_id::text AS "poItemId", g.grn_number AS "grnNumber",
           g.status AS "grnStatus", COALESCE(gi.qty_accepted, 0)::float8 AS "qtyAccepted",
           COALESCE(gi.returned_qty, 0)::float8 AS "returnedQty"
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
     WHERE gi.purchase_order_item_id = ANY(${ids}::uuid[])`;
  return { poLines, grnLines };
}

async function poLinesOf(db, poIds) {
  if (poIds.length === 0) return new Map();
  const rows = await db`
    SELECT po.id::text AS "poId", po.status AS "poStatus", po.received_at AS "receivedAt",
           poi.id::text AS "poItemId", poi.qty::float8 AS qty,
           COALESCE(poi.received_qty, 0)::float8 AS "receivedQty"
      FROM scm.purchase_orders po JOIN scm.purchase_order_items poi ON poi.purchase_order_id = po.id
     WHERE po.id = ANY(${poIds}::uuid[]) AND po.company_id = ${COMPANY_ID}`;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.poId)) out.set(r.poId, { status: r.poStatus, receivedAt: r.receivedAt, lines: [] });
    out.get(r.poId).lines.push(r);
  }
  return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"} company=${COMPANY_ID}`);
  const { poLines, grnLines } = await readState(sql);
  log(`PO lines with a DRAFT / CANCELLED GRN line: ${poLines.length}`);
  const skippedAc = poLines.filter((p) => p.linkedAcDocno);
  if (skippedAc.length) {
    log(`  left alone, AutoCount cutover PO: ${skippedAc.map((p) => `${p.poNumber} ${p.itemCode}`).join("; ")}`);
  }

  const fixes = planStaleReceived(poLines, grnLines);
  if (fixes.length === 0) {
    log("Nothing to repair.");
    await sql.end({ timeout: 5 });
    return;
  }

  const poIds = [...new Set(fixes.map((f) => f.poId))];
  const pos = await poLinesOf(sql, poIds);
  const newQtyById = new Map(fixes.map((f) => [f.poItemId, f.newReceivedQty]));
  const poPlan = poIds.map((poId) => {
    const p = pos.get(poId);
    const after = p.lines.map((l) => ({ ...l, receivedQty: newQtyById.get(l.poItemId) ?? l.receivedQty }));
    return { poId, from: p.status, to: poStatusFromLines(p.status, after), fully: after.every((l) => l.receivedQty >= l.qty) };
  });

  log(`\n=== ${fixes.length} PO LINE(S) TO CORRECT ===`);
  for (const f of fixes) {
    log(`  ${f.poNumber}  ${f.itemCode}  received_qty ${f.receivedQty} -> ${f.newReceivedQty}  (qty ${f.qty})`);
    log(`      voided GRN line(s): ${f.deadGrns.join(", ")}`);
    log(`      bound SO line: ${f.soDocNo ?? "(none)"} reads ${f.soStockStatus ?? "-"} now; the re-walk re-decides it`);
  }
  for (const p of poPlan) {
    const no = fixes.find((f) => f.poId === p.poId).poNumber;
    log(`  ${no} status ${p.from} -> ${p.to ?? `${p.from} (not re-derived)`}`);
  }

  if (!APPLY) {
    log(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  const token = randomUUID();
  await sql.begin(async (tx) => {
    for (const f of fixes) {
      const back = await tx`
        UPDATE scm.purchase_order_items SET received_qty = ${f.newReceivedQty}
         WHERE id = ${f.poItemId}::uuid AND COALESCE(received_qty, 0) = ${f.receivedQty}
        RETURNING id`;
      if (back.length !== 1) throw new Error(`${f.poNumber} ${f.itemCode} changed since it was read; nothing written`);
    }
    for (const p of poPlan) {
      if (!p.to) continue;
      await tx`
        UPDATE scm.purchase_orders
           SET status = ${p.to}, updated_at = now(),
               received_at = CASE WHEN ${p.fully} THEN COALESCE(received_at, now()) ELSE NULL END
         WHERE id = ${p.poId}::uuid AND company_id = ${COMPANY_ID}
           AND status NOT IN ('CANCELLED', 'ON_HOLD')`;
    }
    await tx`
      INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, requested_at, reason)
      VALUES ('GLOBAL', ${token}, now(), ${"HC-0106: cancelled GRN receipt taken off its PO line"})
      ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token,
        requested_at = EXCLUDED.requested_at, reason = EXCLUDED.reason`;
  });
  log(`written: ${fixes.length} PO line(s), ${poPlan.filter((p) => p.to).length} PO status(es), allocation re-walk requested (token ${token}).`);
  await sql.end({ timeout: 5 });

  const check = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  let failed = false;
  try {
    log("\n=== VERIFIED ON A FRESH CONNECTION ===");
    const again = await readState(check);
    const left = planStaleReceived(again.poLines, again.grnLines);
    if (left.length) { failed = true; bad(`${left.length} line(s) still over-report: ${left.map((f) => `${f.poNumber} ${f.itemCode}`).join("; ")}`); }
    for (const f of fixes) {
      const row = again.poLines.find((p) => p.poItemId === f.poItemId);
      const ok = row && row.receivedQty === f.newReceivedQty;
      if (!ok) failed = true;
      log(`  ${ok ? "OK " : "BAD"} ${f.poNumber} ${f.itemCode} received_qty reads ${row?.receivedQty ?? "(missing)"} (want ${f.newReceivedQty})`);
    }
    const posAfter = await poLinesOf(check, poIds);
    for (const p of poPlan) {
      const now = posAfter.get(p.poId);
      const want = p.to ?? p.from;
      const ok = now?.status === want;
      if (!ok) failed = true;
      log(`  ${ok ? "OK " : "BAD"} PO ${p.poId} status reads ${now?.status ?? "(missing)"} (want ${want})`);
    }
    const [q] = await check`SELECT request_token FROM scm.stock_allocation_recompute_queue WHERE job_key = 'GLOBAL'`;
    if (!q) log("  OK  allocation queue row already drained by the cron (the insert committed with the lines)");
    else log(q.request_token === token
      ? "  OK  allocation re-walk request holds our token; the five-minute cron drains it"
      : "  OK  allocation queue row holds a newer token (another writer requested a re-walk too)");
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
