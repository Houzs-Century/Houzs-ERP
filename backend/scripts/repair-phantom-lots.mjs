#!/usr/bin/env node
// ---------------------------------------------------------------------------
// repair-phantom-lots.mjs — retire an orphan lot onto the real one.
//
// PLAN FIRST. plan-phantom-lots.mjs names the shape and has no APPLY path at
// all; this is the write half, and it re-derives everything itself rather than
// trusting a plan produced minutes earlier.
//
// THE SHAPE (proven in production 2026-08-04):
//
//   2990-GRN-2607-001   recv 1  left 1  consumed 0  @ RM2567.60   backed by an IN
//   (orphan)            recv 1  left 0  consumed 1  @ RM2567.60   no movement at all
//
// One documented receipt, two lots. The 2990 import created a second lot with no
// backing movement; the real shipment consumed THAT one, so the GRN's own lot was
// never decremented and sits open forever. The movement ledger is right, the lot
// ledger over-states by exactly the orphan's consumed quantity.
//
// THE REPAIR, per bucket:
//   1. move the orphan's consumption rows onto the backed open lot(s), oldest
//      first, so the consumption points at the lot the goods really came from
//   2. decrement that backed lot by the same quantity
//   3. delete the orphan — it records a receipt no document ever made
//
// THE SAFETY PROPERTY THAT MAKES THIS SANE: it refuses unless the orphan and the
// receiving lot carry the SAME unit_cost_sen. Then re-pointing moves no money —
// COGS is unchanged, and the only figure that moves is inventory value, which
// falls by stock that is not there. A cost difference would silently RESTATE
// COGS on a shipped sale, so that case stops and asks.
//
// DRY-RUN BY DEFAULT. Every bucket is repaired inside a transaction, verified,
// and ROLLED BACK unless APPLY=true AND the confirmation phrase matches. Same
// posture as backfill-fifo-divergence.mjs.
//
// VERIFIES IN-TRANSACTION, before deciding to keep the work: after the repair the
// bucket's lot balance must equal its movement balance, and the total consumed
// quantity must be UNCHANGED (rows moved, none created or destroyed).
//
//   APPLY=true CONFIRM="I HAVE REVIEWED THE DRY-RUN" node backend/scripts/repair-phantom-lots.mjs
// ---------------------------------------------------------------------------
//
// RE-RUN: inert. A phantom lot is deleted or absorbed, so it is not found again.

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

const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const APPLY = process.env.APPLY === "true" && process.env.CONFIRM === CONFIRM_PHRASE;
if (process.env.APPLY === "true" && !APPLY) {
  console.log(`APPLY requested but CONFIRM did not match "${CONFIRM_PHRASE}" — running DRY-RUN instead.\n`);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const rpad = (v, n) => String(v ?? "").padStart(n);
const num = (v) => Number(v ?? 0);
const rm = (sen) => `RM${(num(sen) / 100).toFixed(2)}`;

/** Thrown to force a rollback after a successful dry-run. Not an error. */
class DryRunRollback extends Error {}

let repaired = 0, refused = 0, valueRemoved = 0;

try {
  console.log(`\nPHANTOM LOT REPAIR — ${APPLY ? "APPLY (writes will be COMMITTED)" : "DRY-RUN (nothing will be written)"}\n`);

  const drift = await pg`
    WITH mov AS (
      SELECT warehouse_id, product_code, COALESCE(variant_key,'') AS vkey,
             SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                    WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty
                                    ELSE 0 END) AS mov_qty
        FROM scm.inventory_movements
       GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')
    ), lot AS (
      SELECT warehouse_id, product_code, COALESCE(variant_key,'') AS vkey,
             SUM(qty_remaining) AS lot_qty
        FROM scm.inventory_lots
       GROUP BY warehouse_id, product_code, COALESCE(variant_key,'')
    )
    SELECT m.warehouse_id, m.product_code, m.vkey, m.mov_qty, l.lot_qty
      FROM mov m JOIN lot l
        ON l.warehouse_id = m.warehouse_id AND l.product_code = m.product_code AND l.vkey = m.vkey
     WHERE l.lot_qty <> m.mov_qty
       AND m.mov_qty >= 0            -- a negative movement balance is a different fault
       AND l.lot_qty > m.mov_qty     -- only the lot-ledger-over-stated side
     ORDER BY 2, 3`;

  for (const b of drift) {
    const label = `${b.product_code}${b.vkey ? ` [${b.vkey}]` : ""}`;
    console.log("=".repeat(76));
    console.log(label);

    try {
      await pg.begin(async (sql) => {
        const lots = await sql`
          SELECT l.id, l.qty_received, l.qty_remaining, l.unit_cost_sen, l.received_at,
                 m.id AS mov_exists,
                 COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c
                            WHERE c.lot_id = l.id), 0) AS consumed
            FROM scm.inventory_lots l
            LEFT JOIN scm.inventory_movements m ON m.id = l.movement_id
           WHERE l.warehouse_id = ${b.warehouse_id}
             AND l.product_code = ${b.product_code}
             AND COALESCE(l.variant_key,'') = ${b.vkey}
           ORDER BY l.received_at
           FOR UPDATE OF l`;

        const orphans = lots.filter((l) => !l.mov_exists);
        const open = lots.filter((l) => l.mov_exists && num(l.qty_remaining) > 0);
        const excess = num(b.lot_qty) - num(b.mov_qty);
        const orphanConsumed = orphans.reduce((s, l) => s + num(l.consumed), 0);

        const stop = (why) => { console.log(`  REFUSED — ${why}`); refused++; throw new DryRunRollback("refused"); };

        if (orphans.length === 0) stop("no orphan lot");
        if (open.length === 0) stop("no open backed lot to take the excess off");
        if (orphans.some((l) => num(l.qty_remaining) !== 0)) stop("an orphan still holds stock");
        if (orphanConsumed !== excess) stop(`orphans consumed ${orphanConsumed} but the excess is ${excess}`);

        /* Per-lot CONSERVATION pre-check (2026-08-05). A target lot that already
           breaks `received = consumed + remaining` is a SURPLUS lot — consumption
           rows exist against it while qty_remaining never came down (the 2990
           import's top-up shape). Re-pointing MORE consumptions onto such a lot
           manufactures exactly the `received=1 consumed=2 remaining=0`
           over-consumed state the audit refuses on, and the bucket-level VERIFY
           below cannot see it (bucket sums still balance). This script was the
           only consumption writer in the tree without this check. */
        const surplusTargets = open.filter(
          (l) => num(l.consumed) + num(l.qty_remaining) > num(l.qty_received),
        );
        if (surplusTargets.length > 0) {
          stop(`target lot(s) ${surplusTargets.map((l) => l.id).join(", ")} already break received = consumed + remaining — re-pointing onto them would manufacture an over-consumed lot`);
        }

        /* The property that keeps this cost-neutral. Re-pointing a consumption
           onto a lot with a DIFFERENT unit cost silently restates the COGS of a
           sale that has already shipped, so that case stops rather than guesses. */
        const costs = new Set([...orphans, ...open].map((l) => num(l.unit_cost_sen)));
        if (costs.size > 1) stop(`unit costs differ across the lots (${[...costs].map(rm).join(", ")}) — re-pointing would restate COGS`);

        const consumedBefore = await sql`
          SELECT COALESCE(SUM(c.qty_consumed),0) AS q
            FROM scm.inventory_lot_consumptions c
            JOIN scm.inventory_lots l ON l.id = c.lot_id
           WHERE l.warehouse_id = ${b.warehouse_id} AND l.product_code = ${b.product_code}
             AND COALESCE(l.variant_key,'') = ${b.vkey}`;

        // 1 + 2. Re-point each orphan's consumptions onto open backed lots, oldest first.
        const queue = open.map((l) => ({ id: l.id, left: num(l.qty_remaining) }));
        for (const orph of orphans) {
          const rows = await sql`
            SELECT id, qty_consumed FROM scm.inventory_lot_consumptions
             WHERE lot_id = ${orph.id} ORDER BY id FOR UPDATE`;
          for (const r of rows) {
            let need = num(r.qty_consumed);
            const target = queue.find((q) => q.left >= need) ?? queue.find((q) => q.left > 0);
            if (!target) stop("ran out of open backed lot while re-pointing");
            if (target.left < need) stop("a consumption row would have to be split across lots — not attempted");
            await sql`UPDATE scm.inventory_lot_consumptions SET lot_id = ${target.id} WHERE id = ${r.id}`;
            await sql`UPDATE scm.inventory_lots SET qty_remaining = qty_remaining - ${need} WHERE id = ${target.id}`;
            target.left -= need;
            need = 0;
            console.log(`  re-point ${rpad(num(r.qty_consumed), 3)} unit(s): consumption ${r.id} -> lot ${target.id}`);
          }
          // 3. Retire the orphan.
          await sql`DELETE FROM scm.inventory_lots WHERE id = ${orph.id}`;
          console.log(`  retire orphan lot ${orph.id} (recv ${num(orph.qty_received)}, no document made it)`);
        }

        // ── VERIFY, in-transaction, before this work is allowed to stand ──────
        const [after] = await sql`
          SELECT COALESCE(SUM(qty_remaining),0) AS lot_qty FROM scm.inventory_lots
           WHERE warehouse_id = ${b.warehouse_id} AND product_code = ${b.product_code}
             AND COALESCE(variant_key,'') = ${b.vkey}`;
        const [consAfter] = await sql`
          SELECT COALESCE(SUM(c.qty_consumed),0) AS q
            FROM scm.inventory_lot_consumptions c
            JOIN scm.inventory_lots l ON l.id = c.lot_id
           WHERE l.warehouse_id = ${b.warehouse_id} AND l.product_code = ${b.product_code}
             AND COALESCE(l.variant_key,'') = ${b.vkey}`;

        if (num(after.lot_qty) !== num(b.mov_qty)) {
          stop(`after repair the lot ledger is ${num(after.lot_qty)} but the movement ledger is ${num(b.mov_qty)}`);
        }
        if (num(consAfter.q) !== num(consumedBefore[0].q)) {
          stop(`consumed quantity changed ${num(consumedBefore[0].q)} -> ${num(consAfter.q)} — rows must MOVE, never appear or vanish`);
        }
        /* Per-lot CONSERVATION post-check (2026-08-05): every surviving lot in
           the bucket must read received = consumed + remaining. The bucket-sum
           checks above pass even when one lot is over-consumed and another
           under-consumed by the same amount — which is precisely the damage a
           mis-targeted re-point would leave. Mirrors the family verification in
           backfill-fifo-divergence.mjs. */
        const nonConserving = await sql`
          SELECT l.id, l.qty_received, l.qty_remaining,
                 COALESCE((SELECT SUM(c.qty_consumed)
                             FROM scm.inventory_lot_consumptions c
                            WHERE c.lot_id = l.id), 0) AS consumed
            FROM scm.inventory_lots l
           WHERE l.warehouse_id = ${b.warehouse_id}
             AND l.product_code = ${b.product_code}
             AND COALESCE(l.variant_key,'') = ${b.vkey}
             AND l.qty_received <> l.qty_remaining
                 + COALESCE((SELECT SUM(c.qty_consumed)
                               FROM scm.inventory_lot_consumptions c
                              WHERE c.lot_id = l.id), 0)`;
        if (nonConserving.length > 0) {
          stop(`lot(s) ${nonConserving.map((l) => l.id).join(", ")} end non-conserving (received != consumed + remaining) — the repair would trade bucket drift for lot damage`);
        }

        const value = excess * num(orphans[0].unit_cost_sen);
        console.log(`  VERIFIED. lot ledger ${num(b.lot_qty)} -> ${num(after.lot_qty)}, matches movements. COGS unchanged.`);
        console.log(`  inventory value -${rm(value)}`);
        repaired++; valueRemoved += value;

        if (!APPLY) throw new DryRunRollback("dry-run");
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
      if (e.message === "dry-run") console.log("  (rolled back — dry run)");
    }
    console.log("");
  }

  console.log("=".repeat(76));
  console.log(`  buckets repaired      : ${repaired}`);
  console.log(`  buckets refused       : ${refused}`);
  console.log(`  inventory value off   : ${rm(valueRemoved)}`);
  console.log(APPLY
    ? "\nAPPLIED. Re-run the phantom-lot plan and the inventory integrity check to confirm."
    : `\nDRY-RUN — every bucket was repaired inside a transaction, verified, and rolled back.\nNothing was written. To commit: APPLY=true CONFIRM="${CONFIRM_PHRASE}".`);
} catch (e) {
  console.error("Failed:", e?.message ?? e);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
