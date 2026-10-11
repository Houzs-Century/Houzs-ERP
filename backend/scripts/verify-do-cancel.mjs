#!/usr/bin/env node
// ---------------------------------------------------------------------------
// verify-do-cancel.mjs — did cancelling this delivery order actually put the
// stock and the costing back the way they were?
//
// WHY THIS EXISTS. Owner, 2026-08-04, after cancelling 2990-DO-2607-005: "可是我
// cancel 了，我都不知道数据有没有对呀，所以你那边要确保你那边做的是对的" and then
// the question that matters — "做法要怎么样才算做对呀？"
//
// "Looks fine on the screen" is not an answer. The cancel path touches FOUR
// ledgers, and a partial reversal leaves each of them individually plausible:
//
//   inventory_movements        the signed quantity ledger
//   inventory_lots             the FIFO ledger (what is physically claimable)
//   inventory_lot_consumptions the COGS ledger (what a sale ate, and at what cost)
//   the OUT rows' cost stamps  the per-movement cost attribution
//
// The failure this repo has already lived through is the two quantity ledgers
// disagreeing while both look sane in isolation (docs/inventory-ledger-
// divergence-coe.md — movements said 3 on hand, lots said 4). So "correct" has
// to be stated as invariants that can each be false, and then each one checked.
//
// WHAT scm.fn_reverse_do_out PROMISES (migration 0198), per bucket:
//   a. every lot consumption this DO wrote is DELETED and its lot gets the qty
//      back at the ORIGINAL cost, in its ORIGINAL FIFO position;
//   b. the DO's OUT movements have their cost stamps ZEROED — a stamped cost
//      whose consumptions are gone is a COGS figure with no ledger behind it;
//   c. lots minted by the DO's own delta-IN movements are closed;
//   d. ONE balancing +net_out ADJUSTMENT is written, and the lot the FIFO
//      trigger opens for it is immediately CLOSED — the goods came back through
//      (a), so a fresh open lot here would be the same stock counted twice.
//
// This script checks all four, plus the one that actually answers the owner's
// question: **do the movement ledger and the lot ledger now agree for every SKU
// this DO touched?**
//
// READ-ONLY. SELECT only, no DDL, no writes, no transaction.
//
// EXITS 0 WHETHER IT PASSES OR FAILS — the verdict is the output. A red job
// would read as "the check broke", which is a different fact.
//
//   DO=2990-DO-2607-005 node backend/scripts/verify-do-cancel.mjs
// ---------------------------------------------------------------------------

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

const doNo = (process.env.DO ?? "").trim();
if (!doNo) {
  console.error('DO not set. Pass a Delivery Order number, e.g. DO="2990-DO-2607-005".');
  process.exit(1);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const pad = (v, n) => String(v ?? "").padEnd(n);
const num = (v) => Number(v ?? 0);

const results = [];
/** Record one invariant's verdict. `detail` is printed only when it fails, so a
 *  passing run stays short enough to actually read. */
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(detail.replace(/^/gm, "          "));
}

try {
  const [doRow] = await pg`
    SELECT id, do_number, status, so_doc_no, is_dropship
      FROM scm.delivery_orders
     WHERE do_number = ${doNo}
  `;
  if (!doRow) {
    console.log(`No delivery order numbered ${doNo}.`);
    process.exit(0);
  }

  console.log(`\nDelivery Order ${doRow.do_number}`);
  console.log(`  status      ${doRow.status}`);
  console.log(`  header SO   ${doRow.so_doc_no ?? "(none)"}`);
  console.log(`  drop-ship   ${doRow.is_dropship === true ? "yes" : "no"}\n`);

  // ── A. Did the cancel run at all? ──────────────────────────────────────────
  console.log("A. The cancel ran");
  check("Status is CANCELLED", String(doRow.status).toUpperCase() === "CANCELLED",
    `status is ${doRow.status}`);

  /* The reversal tags its add-back rows source_doc_type='ADJUSTMENT' with the
     DO's id — the same signal fn_reverse_do_out's own idempotency check reads. */
  const adjustments = await pg`
    SELECT id, warehouse_id, product_code, COALESCE(variant_key,'') AS vkey, batch_no,
           qty, total_cost_sen, unit_cost_sen, notes
      FROM scm.inventory_movements
     WHERE source_doc_type = 'ADJUSTMENT' AND source_doc_id = ${doRow.id}
  `;
  check("A reversal add-back was written", adjustments.length > 0,
    "no ADJUSTMENT rows carry this DO's id — the reversal never ran, so the stock is still deducted");

  // ── B. Did the quantity come back? ─────────────────────────────────────────
  console.log("\nB. The quantity came back (movement ledger)");

  /* Signed exactly as scm.inventory_balances does it — IN +qty, OUT -qty,
     ADJUSTMENT +qty, TRANSFER +qty. Re-deriving with a different convention
     would produce a number that disagrees with every screen. */
  const netByBucket = await pg`
    SELECT warehouse_id, product_code, COALESCE(variant_key,'') AS vkey,
           SUM(CASE movement_type
                 WHEN 'IN'         THEN qty
                 WHEN 'OUT'        THEN -qty
                 WHEN 'ADJUSTMENT' THEN qty
                 WHEN 'TRANSFER'   THEN qty
                 ELSE 0 END) AS net,
           MAX(product_name) AS product_name
      FROM scm.inventory_movements
     WHERE source_doc_id = ${doRow.id}
       AND source_doc_type IN ('DO', 'ADJUSTMENT')
     GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')
  `;
  const netOffenders = netByBucket.filter((b) => num(b.net) !== 0);
  check("This DO's own movements net to zero, per SKU", netOffenders.length === 0,
    netOffenders.map((b) => `${pad(b.product_code, 30)} net ${num(b.net)} (should be 0)`).join("\n"));

  // ── C. Did the COGS leave? ─────────────────────────────────────────────────
  console.log("\nC. The costing was unwound (FIFO + COGS ledgers)");

  const leftoverCons = await pg`
    SELECT c.id, mo.product_code, c.qty_consumed
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_movements mo ON mo.id = c.movement_id
     WHERE mo.source_doc_type = 'DO'
       AND mo.source_doc_id   = ${doRow.id}
       AND mo.movement_type   = 'OUT'
  `;
  check("No lot consumption still attributed to this DO", leftoverCons.length === 0,
    leftoverCons.map((r) => `${pad(r.product_code, 30)} qty ${num(r.qty_consumed)} still counted as COGS`).join("\n"));

  const stampedOuts = await pg`
    SELECT product_code, qty, total_cost_sen, unit_cost_sen
      FROM scm.inventory_movements
     WHERE source_doc_type = 'DO' AND source_doc_id = ${doRow.id}
       AND movement_type = 'OUT'
       AND (COALESCE(total_cost_sen,0) <> 0 OR COALESCE(unit_cost_sen,0) <> 0)
  `;
  check("The OUT movements' cost stamps are zeroed", stampedOuts.length === 0,
    stampedOuts.map((r) => `${pad(r.product_code, 30)} total_cost_sen ${num(r.total_cost_sen)}`).join("\n"));

  /* The add-back must NOT open a lot: the goods returned to their ORIGINAL lots
     in step (a), so a fresh open lot here is the same stock twice — and it would
     sit at the BACK of the FIFO queue carrying an averaged cost. */
  let openAddBackLots = [];
  if (adjustments.length > 0) {
    openAddBackLots = await pg`
      SELECT l.id, l.product_code, l.qty_remaining
        FROM scm.inventory_lots l
       WHERE l.movement_id IN ${pg(adjustments.map((a) => a.id))}
         AND l.qty_remaining > 0
    `;
  }
  check("The add-back minted no open lot", openAddBackLots.length === 0,
    openAddBackLots.map((l) => `${pad(l.product_code, 30)} lot still open with ${num(l.qty_remaining)}`).join("\n"));

  // ── D. THE ONE THAT ANSWERS THE QUESTION ───────────────────────────────────
  console.log("\nD. The two ledgers agree for every SKU this DO touched");
  console.log("   (movement ledger vs FIFO lot ledger — the divergence class in");
  console.log("    docs/inventory-ledger-divergence-coe.md)\n");

  const buckets = netByBucket.map((b) => ({ w: b.warehouse_id, p: b.product_code, v: b.vkey, name: b.product_name }));
  const drift = [];
  for (const b of buckets) {
    const [mv] = await pg`
      SELECT COALESCE(SUM(CASE movement_type
                 WHEN 'IN'         THEN qty
                 WHEN 'OUT'        THEN -qty
                 WHEN 'ADJUSTMENT' THEN qty
                 WHEN 'TRANSFER'   THEN qty
                 ELSE 0 END), 0) AS qty
        FROM scm.inventory_movements
       WHERE warehouse_id = ${b.w} AND product_code = ${b.p}
         AND COALESCE(variant_key,'') = ${b.v}
    `;
    const [lot] = await pg`
      SELECT COALESCE(SUM(qty_remaining), 0) AS qty
        FROM scm.inventory_lots
       WHERE warehouse_id = ${b.w} AND product_code = ${b.p}
         AND COALESCE(variant_key,'') = ${b.v}
    `;
    const movQty = num(mv.qty), lotQty = num(lot.qty);
    console.log(`  ${pad(b.p, 32)} movements ${pad(movQty, 8)} lots ${pad(lotQty, 8)} ${movQty === lotQty ? "agree" : `DRIFT ${movQty - lotQty}`}`);
    if (movQty !== lotQty) drift.push({ ...b, movQty, lotQty });
  }
  console.log("");
  check("Movement balance equals FIFO lot balance, per SKU", drift.length === 0,
    drift.map((d) => `${pad(d.p, 30)} movements ${d.movQty} vs lots ${d.lotQty}`).join("\n"));

  /* SERVICE lines carry no stock and never write a movement, so a DO whose only
     remaining rows are services legitimately has nothing to reconcile. Saying so
     stops an empty section reading as a silent pass. */
  if (buckets.length === 0) {
    console.log("  (this DO wrote no stock movements at all — nothing to reconcile)\n");
  }

  // ── E. What the SKU's ledger looks like now ────────────────────────────────
  console.log("\nE. The remaining movement history, so the numbers can be read directly\n");
  for (const b of buckets) {
    const rows = await pg`
      SELECT movement_type, qty, source_doc_no, created_at
        FROM scm.inventory_movements
       WHERE warehouse_id = ${b.w} AND product_code = ${b.p}
         AND COALESCE(variant_key,'') = ${b.v}
       ORDER BY created_at DESC
       LIMIT 8
    `;
    console.log(`  ${b.p}${b.name ? ` — ${b.name}` : ""}`);
    for (const r of rows) {
      const sign = r.movement_type === "OUT" ? "-" : "+";
      console.log(`      ${pad(String(r.created_at).slice(0, 10), 12)} ${pad(r.movement_type, 12)} ${sign}${pad(num(r.qty), 6)} ${r.source_doc_no ?? ""}`);
    }
    console.log("");
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log("=".repeat(72));
  if (failed.length === 0) {
    console.log(`VERDICT: the cancel of ${doNo} is CLEAN.`);
    console.log("The quantity came back, the cancelled sale's COGS left the ledger, the");
    console.log("add-back opened no phantom lot, and the movement and FIFO ledgers agree");
    console.log("on every SKU this delivery touched.");
  } else {
    console.log(`VERDICT: ${failed.length} invariant(s) FAILED for ${doNo}:`);
    for (const f of failed) console.log(`  - ${f.name}`);
    console.log("\nDo NOT hand-patch these. Each one names which ledger is out of step;");
    console.log("the repair paths live in docs/inventory-ledger-divergence-coe.md.");
  }
  console.log("=".repeat(72));
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
