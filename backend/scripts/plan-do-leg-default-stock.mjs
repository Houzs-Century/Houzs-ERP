#!/usr/bin/env node
// Read-only PLAN for the delivery lines stranded by the invented sofa leg height
// (docs/bugs/0722). It writes nothing. There is no apply half yet, deliberately:
// the owner sees the figures first, because every repair here consumes real
// stock and stamps real money.
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW. The answer lives in production and
// nowhere else. Pasting SQL into chat for the owner to run costs an interruption
// every time and puts the production DSN in front of a person for a SELECT.
// Actions already holds `secrets.DATABASE_URL` for the deploy, so the check runs
// there and nobody handles the credential. Same shape as check-soak-gate.mjs.
//
// WHAT IT REPORTS. Three OUT movements went out on "Ship anyway" carrying a
// variant key the delivery form invented (`legheight=default`); they consumed no
// lot and carried no cost, so stock is overstated and the sales carry no COGS.
// For each, this names the lot the corrected key finds, and what the repair
// WOULD consume and stamp. Refusals are outcomes, not errors.
//
// STRICTLY READ-ONLY: three SELECTs, no DDL, no writes, no transaction. Exits 0
// for every legitimate answer — including "nothing to repair" and "everything
// refused" — because a red job reads as "the check broke" and the ANSWER is the
// output. Only an unreachable database or a query error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { planDoLegDefaultRepair, LEG_DEFAULT_FRAGMENT } from "./lib/do-leg-default-repair-plan.mjs";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;

async function main() {
  const url = resolveUrl();
  if (!url) {
    console.error("DATABASE_URL is not set and .dev.vars carries none.");
    process.exit(2);
  }
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 15 });
  try {
    /* 1. Every OUT movement carrying the invented key. Not a hard-coded list of
          document numbers: if the defect ever produced a fourth, this finds it. */
    const movements = await sql`
      select m.id, m.source_doc_no, m.item_code, m.qty, m.warehouse_id,
             m.variant_key, m.unit_cost_sen, m.created_at
        from scm.inventory_movements m
       where m.movement_type = 'OUT'
         and m.variant_key ilike ${"%" + LEG_DEFAULT_FRAGMENT + "%"}
       order by m.source_doc_no, m.item_code
    `;

    if (movements.length === 0) {
      console.log("No OUT movement carries an invented leg height. Nothing to plan.");
      console.log("(If you expected some, docs/bugs/0722 names the three documents.)");
      return;
    }

    /* 2. The OPEN lots that could carry the corrected keys. Scoped to the item
          codes in play so this stays a small read. */
    const itemCodes = [...new Set(movements.map((m) => m.item_code))];
    const lots = await sql`
      select l.id, l.item_code, l.variant_key, l.warehouse_id,
             l.qty_remaining, l.unit_cost_sen, l.batch_no, l.received_at
        from scm.inventory_lots l
       where l.item_code in ${sql(itemCodes)}
         and l.qty_remaining > 0
    `;

    /* 3. Which of those movements already consumed something. A movement with
          any consumption is whole and must not be repaired twice. */
    const consumed = await sql`
      select c.movement_id, count(*)::int as n
        from scm.inventory_lot_consumptions c
       where c.movement_id in ${sql(movements.map((m) => m.id))}
       group by c.movement_id
    `;
    const consumptionCountByMovementId = Object.fromEntries(consumed.map((r) => [r.movement_id, r.n]));

    const { repairs, refusals, totals } = planDoLegDefaultRepair({
      movements: movements.map((m) => ({
        id: m.id,
        sourceDocNo: m.source_doc_no,
        itemCode: m.item_code,
        qty: Number(m.qty),
        warehouseId: m.warehouse_id,
        variantKey: m.variant_key,
        unitCostSen: Number(m.unit_cost_sen),
      })),
      lots: lots.map((l) => ({
        id: l.id,
        itemCode: l.item_code,
        variantKey: l.variant_key,
        warehouseId: l.warehouse_id,
        qtyRemaining: Number(l.qty_remaining),
        unitCostSen: Number(l.unit_cost_sen),
        batchNo: l.batch_no,
        receivedAt: l.received_at,
      })),
      consumptionCountByMovementId,
    });

    console.log(`PLAN — delivery lines stranded by the invented leg height (docs/bugs/0722)`);
    console.log(`Read live, nothing written. ${totals.movementsRead} movement(s) carry ${LEG_DEFAULT_FRAGMENT}.`);
    console.log("");

    if (repairs.length > 0) {
      console.log(`WOULD REPAIR — ${repairs.length} line(s), ${totals.piecesToConsume} piece(s):`);
      for (const r of repairs) {
        console.log(`  ${r.sourceDocNo}  ${r.itemCode}  x${r.qty}`);
        console.log(`      key   ${r.fromKey}`);
        console.log(`         -> ${r.toKey}`);
        console.log(`      lot   ${r.lotId}  batch ${r.batchNo ?? "-"}  holds ${r.lotQtyRemaining}`);
        console.log(`      cost  ${rm(r.unitCostSen)} each -> ${rm(r.totalCostSen)} to stamp`);
      }
      console.log("");
      console.log(`  TOTAL: consume ${totals.piecesToConsume} piece(s), stamp ${rm(totals.costToStampSen)} of COGS.`);
      console.log(`  Stock is overstated by that much today, and those sales carry no cost.`);
      console.log("");
    }

    if (refusals.length > 0) {
      console.log(`REFUSED — ${refusals.length} line(s). A refusal is an ANSWER, not a failure:`);
      for (const f of refusals) {
        console.log(`  ${f.sourceDocNo}  ${f.itemCode}  [${f.reason}]  ${f.detail}`);
      }
      console.log("");
    }

    console.log("NOTHING WAS WRITTEN. This script has no apply mode; the repair that");
    console.log("follows it needs its own tool and the owner's word (docs/bugs/0722).");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("The plan could not be read:", err?.message ?? err);
  process.exit(2);
});
