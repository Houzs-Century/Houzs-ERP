#!/usr/bin/env node
// ---------------------------------------------------------------------------
// repair-orphan-do-movements.mjs — reverse the OUT that its own document
// disowns.
//
// THE SHAPE (proven in production 2026-08-05, provenance run 31011637027):
//
//   Jul 23 ~03:00  DO ships with the line present  -> OUT + consumption (real)
//   line is MOVED to another DO
//   Jul 23 ~04:00  the destination DO ships        -> OUT + consumption (real)
//   the SOURCE DO's OUT was never reversed         -> orphan
//
// Every consumption row is trigger-authored ship-time work — no repair, no
// import wrote them. The goods shipped ONCE (the DO that still carries the
// line). The orphan OUT double-deducts the balance and its consumption
// double-books COGS on a received=1 lot (consumed=2).
//
// THE REPAIR, per orphan movement — an OUT on a shipped, non-cancelled DO that
// carries NO document line for that item:
//   1. delete the orphan's consumption row(s)
//   2. if the lot then UNDER-conserves (received > consumed + remaining),
//      restore qty_remaining by the deficit — that covers the case where the
//      orphan consumed a healthy lot; on the over-consumed lots the delete
//      alone restores conservation and remaining stays untouched
//   3. delete the orphan movement itself (precedent: the dedupe repair deletes
//      movements; an OUT no document made is not history, it is a mistake)
//
// WHAT THIS REFUSES, and why:
//   - a movement whose consumptions do not total |qty|  -> that is the uncosted
//     class (0154 territory), not an orphan reversal
//   - a lot that would end non-conserving either way    -> the repair would
//     trade one fault for another
//   - a bucket whose two ledgers do not AGREE afterwards -> rolled back
//   - anything on a CANCELLED DO                         -> its movements are
//     legitimately netted by the cancel add-back
//
// DRY-RUN BY DEFAULT. Each movement is repaired inside a transaction, verified,
// and ROLLED BACK unless APPLY=true AND the confirmation phrase matches. Same
// posture as repair-phantom-lots.mjs.
//
//   APPLY=true CONFIRM="I HAVE REVIEWED THE DRY-RUN" node backend/scripts/repair-orphan-do-movements.mjs
//
// After an APPLY: dispatch "Restamp DO actual cost" then re-run the integrity
// check — both should come back clean/agreeing.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { DO_STOCK_OUT_STATES } from "./lib/do-shipped-states.mjs";

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

const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const APPLY = process.env.APPLY === "true" && process.env.CONFIRM === CONFIRM_PHRASE;
if (process.env.APPLY === "true" && !APPLY) {
  console.log(`APPLY requested but CONFIRM did not match "${CONFIRM_PHRASE}" — running DRY-RUN instead.\n`);
}

/* The read-side "stock has already gone out" set — one declaration, in
   lib/do-shipped-states.mjs. */
const SHIPPED = DO_STOCK_OUT_STATES;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
const num = (v) => Number(v ?? 0);
const rm = (sen) => `RM${(num(sen) / 100).toFixed(2)}`;

/** Thrown to force a rollback after a successful dry-run. Not an error. */
class DryRunRollback extends Error {}

let repaired = 0, refused = 0, cogsRemovedSen = 0;

try {
  console.log(`\nORPHAN DO MOVEMENT REPAIR — ${APPLY ? "APPLY (writes will be COMMITTED)" : "DRY-RUN (nothing will be written)"}\n`);

  /* Discovery re-derived here, never taken from a plan: every OUT movement on a
     shipped non-cancelled DO whose document carries NO line for that item.
     Service items never move stock and cannot appear as OUT product codes, so no
     service filter is needed on the movement side. */
  const orphans = await pg`
    SELECT m.id AS movement_id, m.qty, m.total_cost_sen, m.warehouse_id,
           m.item_code, COALESCE(m.variant_key,'') AS vkey, m.company_id,
           d.id AS do_id, d.do_number, d.status
      FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id = m.source_doc_id
     WHERE m.source_doc_type = 'DO'
       AND m.movement_type = 'OUT'
       AND upper(d.status::text) = ANY(${SHIPPED})
       AND NOT EXISTS (
             SELECT 1 FROM scm.delivery_order_items i
              WHERE i.delivery_order_id = d.id
                AND i.item_code = m.item_code)
     ORDER BY d.do_number, m.item_code`;

  if (orphans.length === 0) {
    console.log("No orphan OUT movement anywhere (every OUT's DO carries a line for the item). Nothing to repair.");
    process.exit(0);
  }

  console.log(`${orphans.length} orphan OUT movement(s) found:\n`);

  for (const o of orphans) {
    console.log("=".repeat(76));
    console.log(`${o.item_code}  ${rm(o.total_cost_sen)}  on ${o.do_number} (${o.status}) — movement ${o.movement_id}`);

    try {
      await pg.begin(async (sql) => {
        const stop = (why) => { console.log(`  REFUSED — ${why}`); refused++; throw new DryRunRollback("refused"); };

        // The orphan's consumption rows, with their lots locked.
        const cons = await sql`
          SELECT c.id, c.lot_id, c.qty_consumed, c.unit_cost_sen,
                 l.qty_received, l.qty_remaining
            FROM scm.inventory_lot_consumptions c
            JOIN scm.inventory_lots l ON l.id = c.lot_id
           WHERE c.movement_id = ${o.movement_id}
           ORDER BY c.id
           FOR UPDATE OF l`;

        const consumedTotal = cons.reduce((s, r) => s + num(r.qty_consumed), 0);
        if (consumedTotal !== Math.abs(num(o.qty))) {
          stop(`consumptions total ${consumedTotal} but the movement shipped ${Math.abs(num(o.qty))} — uncosted/partial class, not an orphan reversal`);
        }

        let removedSen = 0;
        for (const r of cons) {
          await sql`DELETE FROM scm.inventory_lot_consumptions WHERE id = ${r.id}`;
          removedSen += num(r.qty_consumed) * num(r.unit_cost_sen);

          // Conservation on the lot the row came off. Over-consumed lot: the
          // delete alone restores received = consumed + remaining. Healthy lot:
          // restore the remaining the orphan ate.
          const [after] = await sql`
            SELECT l.qty_received, l.qty_remaining,
                   COALESCE((SELECT SUM(qty_consumed) FROM scm.inventory_lot_consumptions
                              WHERE lot_id = l.id), 0) AS consumed
              FROM scm.inventory_lots l WHERE l.id = ${r.lot_id}`;
          const deficit = num(after.qty_received) - num(after.consumed) - num(after.qty_remaining);
          if (deficit > 0) {
            await sql`UPDATE scm.inventory_lots SET qty_remaining = qty_remaining + ${deficit} WHERE id = ${r.lot_id}`;
            console.log(`  lot ${r.lot_id}: restored qty_remaining +${deficit}`);
          } else if (deficit < 0) {
            stop(`lot ${r.lot_id} would still be over-consumed by ${-deficit} after the delete — another consumer double-books it too; settle that first`);
          } else {
            console.log(`  lot ${r.lot_id}: conserving after delete (was over-consumed — remaining untouched)`);
          }
        }

        await sql`DELETE FROM scm.inventory_movements WHERE id = ${o.movement_id}`;
        console.log(`  deleted consumption(s) ${cons.map((c) => c.id).join(", ")} and movement ${o.movement_id}`);

        // ── VERIFY, in-transaction, before this work is allowed to stand ──────
        // 1. Every touched lot conserves exactly.
        const badLots = await sql`
          SELECT l.id FROM scm.inventory_lots l
           WHERE l.id = ANY(${cons.map((c) => c.lot_id)})
             AND l.qty_received <> l.qty_remaining
                 + COALESCE((SELECT SUM(qty_consumed) FROM scm.inventory_lot_consumptions
                              WHERE lot_id = l.id), 0)`;
        if (badLots.length > 0) stop(`lot(s) ${badLots.map((l) => l.id).join(", ")} end non-conserving`);

        // 2. The bucket's two ledgers agree afterwards.
        const [bucket] = await sql`
          WITH mov AS (
            SELECT COALESCE(SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                                   ELSE qty END), 0) AS mov_qty
              FROM scm.inventory_movements
             WHERE warehouse_id = ${o.warehouse_id} AND item_code = ${o.item_code}
               AND COALESCE(variant_key,'') = ${o.vkey}
          ), lot AS (
            SELECT COALESCE(SUM(qty_remaining), 0) AS lot_qty
              FROM scm.inventory_lots
             WHERE warehouse_id = ${o.warehouse_id} AND item_code = ${o.item_code}
               AND COALESCE(variant_key,'') = ${o.vkey}
          )
          SELECT mov.mov_qty, lot.lot_qty FROM mov, lot`;
        if (num(bucket.mov_qty) !== num(bucket.lot_qty)) {
          stop(`bucket still disagrees after repair: movements ${bucket.mov_qty} vs lots ${bucket.lot_qty}`);
        }

        console.log(`  VERIFIED. bucket movements = lots = ${bucket.mov_qty}. COGS removed ${rm(removedSen)} (double-booked, now single).`);
        cogsRemovedSen += removedSen;
        repaired++;

        if (!APPLY) throw new DryRunRollback("dry-run");
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
  }

  console.log("=".repeat(76));
  console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"}: ${repaired} orphan(s) repair${APPLY ? "ed" : "able"}, ${refused} refused.`);
  console.log(`double-booked COGS removed: ${rm(cogsRemovedSen)}`);
  if (!APPLY) console.log(`\nNothing was written. Re-run with APPLY=true CONFIRM="${CONFIRM_PHRASE}" to commit.`);
  else console.log(`\nNow dispatch "Restamp DO actual cost", then re-run the integrity check.`);
} finally {
  await pg.end({ timeout: 5 });
}
