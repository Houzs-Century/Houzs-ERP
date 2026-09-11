// Write off the COSTED duplicate sofa cutover lots (docs/bugs/0721).
//
// The sibling repair-duplicate-sofa-cutover-lots.mjs retires only ZERO-COST
// duplicates — its guarantee is "the money does not move", and it REFUSES any
// lot carrying cost. After the costing lane (#3486, #3495) put the account
// book's cost on the cutover stock, almost every surplus lot carries one, so
// retiring them is an inventory WRITE-OFF, not a free count correction. This is
// the tool that does the write-off, kept SEPARATE from the zero-cost retire so
// the money-moving mode can never be reached by accident from the tool whose
// contract is that money does not move.
//
// Reviewed live before it existed: plan-writeoff-duplicate-sofa-lots.mjs
// (read-only) reported the exact list and the total value. The owner approved
// the write-off with that figure in front of them.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────────
//   The SAME planner (planDuplicateSofaLots) with allowCostedRetire=true, so the
//   keep rule and EVERY other refusal are identical — consumed, part-consumed,
//   live-SO-bound and MODEL-NOT-ON-ORDER lots (the docs/bugs/0723 nine) still
//   stay. Only a surplus lot carrying cost, which the retire tool refuses, is
//   retired here.
//
//   One negative ADJUSTMENT per surplus lot at the lot's own (warehouse, item,
//   STALE variant key, batch). The FIFO exact-batch consume matches ONLY that
//   lot — the keeper is under a different key — and the trigger stamps the real
//   total_cost_sen from the consumed lot, so inventory VALUE falls by exactly
//   that lot's cost. reason_code is WRITEOFF (the catalogue's own word,
//   shared/adjustment-reasons.ts), NOT the retire's COUNT: this moved value and
//   the ledger must say so. Reversible by the opposite adjustment.
//
// ── HOW TO RUN ───────────────────────────────────────────────────────────────
//   MODE=plan (default) reads and writes NOTHING.
//     DATABASE_URL=... node backend/scripts/writeoff-duplicate-sofa-lots.mjs
//   To apply, both are required:
//     MODE=apply CONFIRM="WRITE OFF THE DUPLICATE SOFA LOTS" node ...
//   Optional: BATCH=HC-PO-009712 narrows to one purchase order.
//
// RE-RUN: convergent. A written-off lot has qty_remaining 0, so it is no longer
// OPEN and the next run does not see it. A second apply with nothing to do
// writes nothing. It can never write off the same lot twice.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { planDuplicateSofaLots, variantKeyMirror } from "./lib/duplicate-sofa-lot-plan.mjs";

const CONFIRM_PHRASE = "WRITE OFF THE DUPLICATE SOFA LOTS";
const MODE = (process.env.MODE ?? "plan").toLowerCase();
const ONE_BATCH = (process.env.BATCH ?? "").trim() || null;
const COMPANY = Number(process.env.COMPANY ?? 1);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;

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
  process.exit(2);
}
// CONFIRM is compared HERE, with the refusing exit adjacent (release-discipline).
if (MODE === "apply" && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was read or written.`);
  process.exit(2);
}
const APPLY = MODE === "apply";
const log = (...a) => console.log(...a);

/* Two connections constructed literally so the release-discipline gate can SEE
   the second one, and so a reader can: the session that wrote is the worst
   witness that the write landed. */
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
     WHERE p.po_number = ANY(${batches}) AND i.item_group = 'sofa'`;
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
      createdAt: l.created_at, consumptions: Number(l.consumptions ?? 0), productName: l.product_name,
    })),
    poLines: poLines.map((p) => ({ poNumber: p.po_number, itemCode: p.item_code, itemGroup: p.item_group, variants: p.variants })),
    soBindings: soBindings.map((s) => ({ batchNo: s.batch_no, itemCode: s.item_code, variantKey: variantKeyMirror(s.item_group, s.variants) })),
    computeKey: variantKeyMirror,
    allowCostedRetire: true,
  };
}

async function main() {
  log(`\nWRITE-OFF DUPLICATE SOFA CUTOVER LOTS — ${APPLY ? "APPLY (writes will be COMMITTED)" : "PLAN (nothing is written)"}`);
  log(`company ${COMPANY}${ONE_BATCH ? `, batch ${ONE_BATCH}` : ", all batches"}\n`);

  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const world = await readWorld(sql);
  const plan = planDuplicateSofaLots(toPlanInput(world));

  const valueSen = plan.retire.reduce((s, r) => s + Number(r.unitCostSen) * Number(r.qty), 0);
  log(`TO WRITE OFF: ${plan.retire.length} surplus lot(s) / ${plan.retire.reduce((s, r) => s + r.qty, 0)} piece(s), inventory value ${rm(valueSen)}`);
  for (const r of plan.retire) {
    log(`   - ${r.batchNo} ${r.itemCode} x${r.qty}  ${rm(Number(r.unitCostSen) * Number(r.qty))}`);
    log(`       stale   "${r.staleKey}"`);
    log(`       keeping "${r.currentKey}"  (the purchase line's key today)`);
  }
  log(`\nREFUSED (kept): ${plan.refusals.length}`);
  for (const f of plan.refusals) log(`   - ${f.batchNo} ${f.itemCode}: ${f.why}`);

  /* This tool's whole purpose is costed lots, so — unlike the retire tool — a
     zero-cost surplus is the surprise. It is harmless to write off (value 0),
     but flag it so the operator knows the population was not what was expected. */
  const zeroCost = plan.retire.filter((r) => Number(r.unitCostSen) === 0);
  if (zeroCost.length > 0) log(`\nNOTE: ${zeroCost.length} of the planned lots carry no cost — the zero-cost retire tool is the right home for those.`);

  if (!APPLY) {
    log(`\nPLAN ONLY — nothing was written. To apply:\n  MODE=apply CONFIRM="${CONFIRM_PHRASE}" ...`);
    await sql.end();
    return;
  }

  /* ── Write ── one ADJUSTMENT per lot, one tx each so a failure cannot
     half-apply. Every value BOUND. reason_code WRITEOFF — this moves value. */
  const mvCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name='inventory_movements'`).map((r) => r.column_name);
  const hasCompany = mvCols.includes("company_id");
  let done = 0;
  const failures = [];
  for (const r of plan.retire) {
    try {
      await sql.begin(async (tx) => {
        const cols = ["movement_type", "warehouse_id", "item_code", "variant_key", "qty",
          "unit_cost_sen", "batch_no", "source_doc_type", "source_doc_no", "reason_code", "notes"];
        const args = ["ADJUSTMENT", r.warehouseId, r.itemCode, r.staleKey, -r.qty, Number(r.unitCostSen), r.batchNo,
          "ADJUSTMENT", "SOFA-DUP-WRITEOFF-2026-09-11", "WRITEOFF",
          `Costed duplicate sofa cutover lot written off: this build re-keyed to "${r.currentKey}" and was opened a second time under "${r.staleKey}". One physical sofa; the second lot was wrongly costed at ${rm(Number(r.unitCostSen))}. docs/bugs/0721`];
        if (hasCompany) { cols.push("company_id"); args.push(COMPANY); }
        await tx.unsafe(`INSERT INTO scm.inventory_movements (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, args);
      });
      done++;
    } catch (e) {
      failures.push({ lot: r.lotId, error: String(e?.message ?? e) });
    }
  }
  log(`\nWRITTEN: ${done} of ${plan.retire.length} write-off movement(s); failures ${failures.length}`);
  for (const f of failures) log(`   FAILED ${f.lot}: ${f.error}`);
  await sql.end();

  /* ── Verify on a FRESH connection, assert the SHAPE and the VALUE ──────────
     Every targeted lot EMPTY; every repaired cell holds exactly ONE open key;
     and the ADJUSTMENTs actually booked the value we expected to remove. */
  const v = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const targeted = plan.retire.map((r) => r.lotId);
  const after = targeted.length === 0 ? [] : await v`SELECT id, qty_remaining FROM scm.inventory_lots WHERE id = ANY(${targeted})`;
  const stillOpen = after.filter((l) => Number(l.qty_remaining) !== 0);
  const cells = [...new Set(plan.retire.map((r) => `${r.batchNo}|${r.itemCode}`))];
  const keysNow = cells.length === 0 ? [] : await v`
    SELECT batch_no, item_code, COUNT(DISTINCT COALESCE(variant_key,'')) keys
      FROM scm.inventory_lots
     WHERE source_doc_type = 'AC_CUTOVER' AND qty_remaining > 0
       AND (batch_no || '|' || item_code) = ANY(${cells})
     GROUP BY 1, 2`;
  const multi = keysNow.filter((k) => Number(k.keys) !== 1);
  const booked = await v`
    SELECT COALESCE(SUM(total_cost_sen),0) sen FROM scm.inventory_movements
     WHERE source_doc_no = 'SOFA-DUP-WRITEOFF-2026-09-11' AND reason_code = 'WRITEOFF' AND movement_type = 'ADJUSTMENT'`;
  await v.end();

  log("\nVERIFY (fresh connection):");
  log(`   targeted lots now empty: ${after.length - stillOpen.length} of ${targeted.length}`);
  log(`   repaired cells holding exactly ONE open key: ${keysNow.length - multi.length} of ${keysNow.length}`);
  log(`   inventory value removed (booked total_cost_sen): ${rm(Number(booked[0].sen))}  (planned ${rm(valueSen)})`);
  for (const l of stillOpen) log(`   SHAPE PROBLEM: lot ${l.id} still holds ${l.qty_remaining}`);
  for (const k of multi) log(`   SHAPE PROBLEM: ${k.batch_no} ${k.item_code} still has ${k.keys} open keys`);

  if (stillOpen.length > 0 || multi.length > 0 || failures.length > 0) {
    console.error("\nFAILED — see the shape problems above. Nothing was deleted; the write-offs that DID land are reversible by the opposite adjustment.");
    process.exit(1);
  }
  log("\nOK — every planned lot written off and every repaired cell holds one build.");
  log("Run the SO stock allocation recompute afterwards: a direct SQL stock write does not trigger a projection recompute (docs/bugs/0675).");
}

main().catch((e) => { console.error(e); process.exit(1); });
