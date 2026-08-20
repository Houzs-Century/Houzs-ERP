#!/usr/bin/env node
// ---------------------------------------------------------------------------
// plan-phantom-lots.mjs — what would it take to make the lot ledger agree?
//
// WHY THIS EXISTS, and why it does not write.
//
// After the 2026-08-04 duplicate-delivery cleanup, three SKUs still disagree
// between their two stock ledgers. The MOVEMENT ledger — the number the
// Inventory screen shows and MRP allocates from — is CORRECT on all of them,
// proven against the documents. The LOT ledger (FIFO, COGS, inventory value)
// carries units that are not there.
//
// The existing repair modes do not fit this shape:
//   MODE=reconstruct  planned to rebuild consumptions for a CANCELLED DO and
//                     stamp RM3641.60 of COGS onto it (blocked in #1600)
//   MODE=relabel      plans 0 movements, closes 0 buckets — it refuses, honestly
//
// So the shape needs naming before it needs fixing, and THAT is this script.
// It classifies each drifted bucket and says which have a provable repair,
// what that repair would be, and what it would cost. It writes NOTHING, and
// there is deliberately no APPLY path in it: on this ledger, this week, I have
// been wrong five times and been saved by a dry-run twice. A planner that
// cannot write cannot repeat that.
//
// THE SHAPE IT IS LOOKING FOR — an ORPHAN LOT.
//
//   2990-GRN-2607-001   recv 1  left 1   opened by an IN movement
//   (unknown)           recv 1  left 0   opened by NOTHING — consumed
//
// One documented receipt, two lots. The orphan carries no `movement_id` that
// resolves, so nothing in the ledger explains where it came from — the 2990
// import is the known source (docs/inventory-ledger-divergence-coe.md). The
// real shipment consumed the ORPHAN, leaving the GRN's own lot open forever.
//
// A repair is PROVABLE when, for a bucket:
//   * the movement ledger already equals the document truth (so movements are
//     not what is wrong), AND
//   * the excess lot quantity is exactly accounted for by lots whose
//     consumptions came from orphans, AND
//   * every orphan lot is FULLY consumed (qty_remaining = 0) — a partially
//     consumed orphan means live stock is sitting on it and the story is not
//     the simple one.
//
// Anything else is reported as NEEDS REVIEW with the reason, never guessed at.
//
// READ-ONLY. SELECT only, no DDL, no writes, no transaction, no APPLY flag.
//
//   node backend/scripts/plan-phantom-lots.mjs
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

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const pad = (v, n) => String(v ?? "").padEnd(n);
const rpad = (v, n) => String(v ?? "").padStart(n);
const num = (v) => Number(v ?? 0);
const rm = (sen) => `RM${(num(sen) / 100).toFixed(2)}`;

try {
  console.log("\nPHANTOM LOT PLANNER — read-only, no APPLY path exists in this script\n");

  /* Every bucket where the two ledgers disagree. Signed exactly as
     scm.inventory_balances does it, so the movement figure is the same one the
     Inventory screen shows. */
  const drift = await pg`
    WITH mov AS (
      SELECT warehouse_id, item_code, COALESCE(variant_key,'') AS vkey, company_id,
             SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                    WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty
                                    ELSE 0 END) AS mov_qty
        FROM scm.inventory_movements
       GROUP BY warehouse_id, item_code, COALESCE(variant_key,''), company_id
    ), lot AS (
      SELECT warehouse_id, item_code, COALESCE(variant_key,'') AS vkey, company_id,
             SUM(qty_remaining) AS lot_qty
        FROM scm.inventory_lots
       GROUP BY warehouse_id, item_code, COALESCE(variant_key,''), company_id
    )
    SELECT COALESCE(m.warehouse_id, l.warehouse_id) AS warehouse_id,
           COALESCE(m.item_code, l.item_code) AS item_code,
           COALESCE(m.vkey, l.vkey)                 AS vkey,
           COALESCE(m.company_id, l.company_id)     AS company_id,
           COALESCE(m.mov_qty, 0) AS mov_qty,
           COALESCE(l.lot_qty, 0) AS lot_qty
      FROM mov m
      FULL OUTER JOIN lot l
        ON l.warehouse_id = m.warehouse_id AND l.item_code = m.item_code
       AND l.vkey = m.vkey AND l.company_id IS NOT DISTINCT FROM m.company_id
     WHERE COALESCE(m.mov_qty, 0) <> COALESCE(l.lot_qty, 0)
     ORDER BY 2, 3`;

  if (drift.length === 0) {
    console.log("No bucket disagrees. Nothing to plan.\n");
    process.exit(0);
  }
  console.log(`${drift.length} bucket(s) where the movement ledger and the lot ledger disagree.\n`);

  const provable = [], review = [];

  for (const b of drift) {
    const lots = await pg`
      SELECT l.id, l.qty_received, l.qty_remaining, l.unit_cost_sen, l.source_doc_no,
             l.movement_id,
             m.id AS mov_exists, m.movement_type, m.source_doc_no AS opened_by,
             COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c
                        WHERE c.lot_id = l.id), 0) AS consumed
        FROM scm.inventory_lots l
        LEFT JOIN scm.inventory_movements m ON m.id = l.movement_id
       WHERE l.warehouse_id = ${b.warehouse_id}
         AND l.item_code = ${b.item_code}
         AND COALESCE(l.variant_key,'') = ${b.vkey}
       ORDER BY l.received_at`;

    const orphans = lots.filter((l) => !l.mov_exists);
    const backed = lots.filter((l) => l.mov_exists);
    const excess = num(b.lot_qty) - num(b.mov_qty);

    console.log("=".repeat(76));
    console.log(`${b.item_code}${b.vkey ? `  [${b.vkey}]` : ""}  co=${b.company_id}`);
    console.log(`  movement ledger ${rpad(num(b.mov_qty), 6)}    lot ledger ${rpad(num(b.lot_qty), 6)}    excess ${rpad(excess, 6)}`);
    console.log(`  lots: ${lots.length}  (${orphans.length} orphan — opened by no movement)\n`);
    for (const l of lots) {
      const tag = l.mov_exists ? `opened by ${l.movement_type} ${l.opened_by ?? ""}` : "ORPHAN — no backing movement";
      console.log(`      recv ${rpad(num(l.qty_received), 4)} left ${rpad(num(l.qty_remaining), 4)} consumed ${rpad(num(l.consumed), 4)} @ ${pad(rm(l.unit_cost_sen), 12)} ${tag}`);
    }

    /* The three conditions, checked one at a time so a refusal names WHICH one
       failed rather than just declining. */
    const reasons = [];
    if (orphans.length === 0) reasons.push("no orphan lot — the excess is not this shape");
    if (excess <= 0) reasons.push(`excess is ${excess}, not positive — the lot ledger is not the over-stated side`);
    /* `excess = lot - mov` goes positive for TWO different reasons, and only one
       of them is this shape. A NEGATIVE movement balance — stock shipped that was
       never received — also makes it positive while the lot ledger sits at 0 and
       is not over-stated at all. The first run of this planner called exactly
       that PROVABLE, on a bucket with zero backed lots and an RM0.00 impact, and
       then offered to "re-point onto the backed lot(s)" that did not exist.
       A negative movement balance is its own fault (the sofa variant-key family),
       not a phantom lot. */
    if (num(b.mov_qty) < 0) reasons.push(`movement ledger is ${num(b.mov_qty)} — negative on-hand is its own fault, not a phantom lot`);
    if (backed.filter((l) => num(l.qty_remaining) > 0).length === 0) {
      reasons.push("no OPEN backed lot to correct — there is nothing over-stated to take the excess off");
    }
    const partialOrphan = orphans.find((l) => num(l.qty_remaining) !== 0);
    if (partialOrphan) reasons.push(`orphan lot ${partialOrphan.id} still has ${num(partialOrphan.qty_remaining)} remaining — live stock sits on it`);
    const orphanConsumed = orphans.reduce((s, l) => s + num(l.consumed), 0);
    if (orphans.length > 0 && orphanConsumed !== excess) {
      reasons.push(`orphan lots account for ${orphanConsumed} consumed but the excess is ${excess} — they do not explain each other`);
    }

    if (reasons.length === 0) {
      /* The open backed lots are the phantom: their goods were really shipped,
         the shipment just drew from the orphan instead. */
      const openBacked = backed.filter((l) => num(l.qty_remaining) > 0);
      const value = openBacked.reduce((s, l) => s + num(l.qty_remaining) * num(l.unit_cost_sen), 0);
      console.log(`\n  PROVABLE. The excess of ${excess} sits on ${openBacked.length} backed lot(s) whose goods`);
      console.log(`  really shipped — the shipment drew from the orphan instead, so the real lot`);
      console.log(`  was never decremented.`);
      console.log(`  Repair would: re-point the orphan's ${orphanConsumed} consumed unit(s) onto the backed lot(s),`);
      console.log(`                then retire the orphan (it records a receipt no document made).`);
      console.log(`  INVENTORY VALUE would fall by ${rm(value)} — that stock is not there.`);
      provable.push({ ...b, excess, value, orphanConsumed });
    } else {
      console.log(`\n  NEEDS REVIEW — not provable from the ledger:`);
      for (const r of reasons) console.log(`      - ${r}`);
      review.push({ ...b, excess, reasons });
    }
    console.log("");
  }

  console.log("=".repeat(76));
  console.log("SUMMARY\n");
  console.log(`  provable orphan-lot buckets   : ${provable.length}`);
  console.log(`  inventory value overstated    : ${rm(provable.reduce((s, p) => s + p.value, 0))}`);
  console.log(`  buckets needing review        : ${review.length}`);
  for (const r of review) console.log(`      ${pad(r.item_code, 26)} ${r.reasons[0]}`);
  console.log(`\nNothing was written. This script has no APPLY path by design — the repair`);
  console.log(`itself is a separate change, reviewed against this plan first.`);
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
