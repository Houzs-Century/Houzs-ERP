#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Retire the sofa cutover lots that are the SAME physical sofa opened twice.
//
// WHAT WENT WRONG (traced, docs/bugs/0721). `import-ac-sofa-stock.mjs` tests
// whether it has already opened a build with its own section-6 key:
// (item code, warehouse, batch, VARIANT KEY). The variant key is computed from
// the document, so a build whose sales line gains or loses a special AFTER its
// lots were opened re-keys, reads as a cell nobody has opened, and is opened a
// second time. HC-SO-012629 gained "Nylon Fabric"; HC-PO-009712 now holds two
// sets of 5535 compartments for one sofa.
//
// THE SIZE OF IT, measured on production 2026-09-08 (not one sofa):
//   73 purchase orders hold open sofa cutover stock; their own sofa lines
//   justify 73 builds. The lot table holds 93 distinct (batch, model, key)
//   builds. 222 pieces open. Most of the surplus was written by the
//   2026-09-07 20:49 run (78 lots / 32 batches), one more by 2026-09-08 13:03.
//
// ── WHAT IT DOES ───────────────────────────────────────────────────────────
//   NOTHING IS DELETED. A surplus lot is retired the way this system removes
//   stock that is not there: one negative ADJUSTMENT movement per lot, at the
//   lot's own (warehouse, item, variant key, batch), which the FIFO trigger
//   (mig 0126, fn_consume_fifo_batch) consumes against that exact lot. The lot
//   row stays, its consumption is recorded, and the write is reversible by the
//   opposite adjustment. reason_code is COUNT — a count correction is what this
//   is, and it is the catalogue's own word (shared/adjustment-reasons.ts).
//
//   THE KEEP RULE IS THE PURCHASE LINE, not the newest lot. The lot that
//   survives carries the key the purchase line computes TODAY, because that is
//   the key findCoveringBatch and the delivery pre-flight both ask for. Where no
//   open lot matches the purchase line, the group is REFUSED — picking one would
//   be a guess, and two wrong keys is a finding.
//
//   THE MONEY DOES NOT MOVE. A lot carrying any cost is refused, so every write
//   this makes is at 0 sen. Inventory VALUE falls by nothing; only the count
//   does, which is the whole point.
//
//   IT REFUSES, LOUDLY, five ways: a lot that has been consumed, a part-consumed
//   lot, a lot carrying cost, a lot a live sales order is allocated to by its
//   exact key, and a cell whose ITEM CODE is on no line of the order it claims
//   to come from (three such sets exist and are reported, never touched — what
//   wrote them is unsettled, and retiring them would destroy that evidence).
//
// ── HOW TO RUN IT ──────────────────────────────────────────────────────────
//   MODE=plan (the default) reads and writes NOTHING.
//     DATABASE_URL=... node backend/scripts/repair-duplicate-sofa-cutover-lots.mjs
//   To apply, both are required:
//     MODE=apply CONFIRM="RETIRE THE DUPLICATE SOFA LOTS" node ...
//   Optional: BATCH=HC-PO-009712 narrows everything to one purchase order.
//
// RE-RUN: convergent. A retired lot has qty_remaining 0, so it is no longer
// OPEN and the next run does not see it. A second apply with nothing to do
// writes nothing and reports 0. It is NOT idempotent in the harmful direction:
// it can never retire the same lot twice, because the lot it would target is
// already empty.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { planDuplicateSofaLots, variantKeyMirror } from "./lib/duplicate-sofa-lot-plan.mjs";

const CONFIRM_PHRASE = "RETIRE THE DUPLICATE SOFA LOTS";
const MODE = (process.env.MODE ?? "plan").toLowerCase();
const APPLY = MODE === "apply" && process.env.CONFIRM === CONFIRM_PHRASE;
const ONE_BATCH = (process.env.BATCH ?? "").trim() || null;
const COMPANY = Number(process.env.COMPANY ?? 1);

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
if (MODE === "apply" && !APPLY) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was read or written.`);
  process.exit(1);
}

const log = (...a) => console.log(...a);
/* Two connections are constructed literally, not through a helper, so that the
   release-discipline gate can SEE the second one — and so can a reader. The
   session that wrote is the worst witness that the write landed. */

async function readWorld(sql) {
  const lots = await sql`
    SELECT l.id, l.batch_no, l.item_code, COALESCE(l.variant_key,'') variant_key,
           l.warehouse_id, l.qty_received, l.qty_remaining, l.unit_cost_sen,
           l.created_at, l.product_name,
           (SELECT COUNT(*) FROM scm.inventory_lot_consumptions c WHERE c.lot_id = l.id) consumptions
      FROM scm.inventory_lots l
     WHERE l.source_doc_type = 'AC_CUTOVER'
       AND l.batch_no LIKE 'HC-PO-%'
       AND l.qty_remaining > 0
       AND l.company_id = ${COMPANY}
       AND (${ONE_BATCH}::text IS NULL OR l.batch_no = ${ONE_BATCH})
     ORDER BY l.batch_no, l.item_code, l.created_at`;

  const batches = [...new Set(lots.map((l) => l.batch_no))];
  const poLines = batches.length === 0 ? [] : await sql`
    SELECT p.po_number, i.item_code, i.item_group, i.variants
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.po_number = ANY(${batches})
       AND i.item_group = 'sofa'`;

  const soBindings = batches.length === 0 ? [] : await sql`
    SELECT s.allocated_batch_no batch_no, s.item_code, s.item_group, s.variants
      FROM scm.mfg_sales_order_items s
     WHERE s.allocated_batch_no = ANY(${batches})`;

  return { lots, poLines, soBindings };
}

function toPlanInput({ lots, poLines, soBindings }) {
  return {
    lots: lots.map((l) => ({
      id: l.id, batchNo: l.batch_no, itemCode: l.item_code, variantKey: l.variant_key,
      warehouseId: l.warehouse_id, qtyReceived: Number(l.qty_received),
      qtyRemaining: Number(l.qty_remaining), unitCostSen: Number(l.unit_cost_sen ?? 0),
      createdAt: l.created_at, consumptions: Number(l.consumptions ?? 0),
      productName: l.product_name,
    })),
    poLines: poLines.map((p) => ({
      poNumber: p.po_number, itemCode: p.item_code, itemGroup: p.item_group, variants: p.variants,
    })),
    /* A binding's key is computed from the ORDER's own line, the same way the
       allocator does — never read off the lot, which is the thing under test. */
    soBindings: soBindings.map((s) => ({
      batchNo: s.batch_no, itemCode: s.item_code,
      variantKey: variantKeyMirror(s.item_group, s.variants),
    })),
    computeKey: variantKeyMirror,
  };
}

async function main() {
  log(`\nDUPLICATE SOFA CUTOVER LOTS — ${APPLY ? "APPLY (writes will be COMMITTED)" : "PLAN (nothing is written)"}`);
  log(`company ${COMPANY}${ONE_BATCH ? `, batch ${ONE_BATCH}` : ", all batches"}\n`);

  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const world = await readWorld(sql);
  log(`open sofa cutover lots: ${world.lots.length} (${world.lots.reduce((s, l) => s + Number(l.qty_remaining), 0)} pieces) across ${new Set(world.lots.map((l) => l.batch_no)).size} purchase orders`);
  log(`their purchase orders' sofa lines: ${world.poLines.length}; sales lines allocated to those batches: ${world.soBindings.length}`);

  const plan = planDuplicateSofaLots(toPlanInput(world));

  log(`\nTO RETIRE: ${plan.retire.length} lot(s) / ${plan.retire.reduce((s, r) => s + r.qty, 0)} piece(s)`);
  for (const r of plan.retire) {
    log(`   - ${r.batchNo} ${r.itemCode} x${r.qty}`);
    log(`       stale   "${r.staleKey}"`);
    log(`       keeping "${r.currentKey}"  (the purchase line's key today)`);
  }
  log(`\nREFUSED: ${plan.refusals.length}`);
  for (const f of plan.refusals) log(`   - ${f.batchNo} ${f.itemCode}: ${f.why}`);

  if (plan.retire.some((r) => r.unitCostSen !== 0)) {
    console.error("\nABORT: a planned retirement carries cost. The planner must never produce this; refusing rather than moving money.");
    await sql.end();
    process.exit(1);
  }

  if (!APPLY) {
    log(`\nPLAN ONLY — nothing was written. To apply:\n  MODE=apply CONFIRM="${CONFIRM_PHRASE}" ...`);
    await sql.end();
    return;
  }

  /* ── Write ──────────────────────────────────────────────────────────────
     One movement per lot, inside ONE transaction per lot so a failure cannot
     half-retire a build. Every value is BOUND, never interpolated. */
  const mvCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name='inventory_movements'`).map((r) => r.column_name);
  const hasCompany = mvCols.includes("company_id");
  let done = 0;
  const failures = [];
  for (const r of plan.retire) {
    try {
      await sql.begin(async (tx) => {
        const cols = ["movement_type", "warehouse_id", "item_code", "variant_key", "qty",
          "unit_cost_sen", "batch_no", "source_doc_type", "source_doc_no", "reason_code", "notes"];
        const args = ["ADJUSTMENT", r.warehouseId, r.itemCode, r.staleKey, -r.qty, 0, r.batchNo,
          "ADJUSTMENT", "SOFA-DUP-LOT-2026-09-08", "COUNT",
          `Duplicate sofa cutover lot retired: this build re-keyed to "${r.currentKey}" and was opened a second time under "${r.staleKey}". One physical sofa. docs/bugs/0721`];
        if (hasCompany) { cols.push("company_id"); args.push(COMPANY); }
        await tx.unsafe(
          `INSERT INTO scm.inventory_movements (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
          args);
      });
      done++;
    } catch (e) {
      failures.push({ lot: r.lotId, error: String(e?.message ?? e) });
    }
  }
  log(`\nWRITTEN: ${done} of ${plan.retire.length} retirement movement(s); failures ${failures.length}`);
  for (const f of failures) log(`   FAILED ${f.lot}: ${f.error}`);
  await sql.end();

  /* ── Verify on a FRESH connection, and assert the SHAPE ─────────────────
     A count is not a shape. What must be true afterwards: every targeted lot is
     EMPTY, every cell that was repaired now holds exactly ONE open key, and no
     lot outside the plan lost anything. */
  const v = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const targeted = plan.retire.map((r) => r.lotId);
  const after = targeted.length === 0 ? [] : await v`
    SELECT id, qty_remaining FROM scm.inventory_lots WHERE id = ANY(${targeted})`;
  const stillOpen = after.filter((l) => Number(l.qty_remaining) !== 0);

  const cells = [...new Set(plan.retire.map((r) => `${r.batchNo}|${r.itemCode}`))];
  const keysNow = cells.length === 0 ? [] : await v`
    SELECT batch_no, item_code, COUNT(DISTINCT COALESCE(variant_key,'')) keys, SUM(qty_remaining) qty
      FROM scm.inventory_lots
     WHERE source_doc_type = 'AC_CUTOVER' AND qty_remaining > 0
       AND (batch_no || '|' || item_code) = ANY(${cells})
     GROUP BY 1, 2`;
  const multi = keysNow.filter((k) => Number(k.keys) !== 1);

  log("\nVERIFY (fresh connection):");
  log(`   targeted lots now empty: ${after.length - stillOpen.length} of ${targeted.length}`);
  log(`   repaired cells holding exactly ONE open key: ${keysNow.length - multi.length} of ${keysNow.length}`);
  for (const l of stillOpen) log(`   SHAPE PROBLEM: lot ${l.id} still holds ${l.qty_remaining}`);
  for (const k of multi) log(`   SHAPE PROBLEM: ${k.batch_no} ${k.item_code} still has ${k.keys} open keys`);
  await v.end();

  if (stillOpen.length > 0 || multi.length > 0 || failures.length > 0) {
    console.error("\nFAILED — see the shape problems above. Nothing was deleted; the retirements that DID land are reversible by the opposite adjustment.");
    process.exit(1);
  }
  log("\nOK — every planned lot is retired and every repaired cell holds one build.");
  log("Run the SO stock allocation recompute afterwards: a direct SQL stock write does not trigger a projection recompute (docs/bugs/0675).");
}

main().catch((e) => { console.error(e); process.exit(1); });
