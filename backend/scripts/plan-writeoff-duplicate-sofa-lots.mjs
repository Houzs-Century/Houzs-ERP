// Read-only PLAN for writing off the COSTED duplicate sofa cutover lots
// (docs/bugs/0721). It writes nothing. There is no apply half here: retiring a
// costed lot removes inventory VALUE, so the owner sees the exact figure first.
//
// WHY A SEPARATE PLAN FROM repair-duplicate-sofa-cutover-lots.mjs. That tool
// retires only ZERO-COST duplicates — its guarantee is "the money does not
// move", and it REFUSES any lot carrying cost. It was correct while the cutover
// stock was uncosted. Then the costing lane (#3486, #3495) gave the stock the
// account book's cost, so 60 of the ~62 surplus lots now carry one. Retiring
// them is no longer a free count correction; it is an inventory WRITE-OFF. This
// plan uses the SAME planner with its `allowCostedRetire` opt-in, so the keep
// rule and every OTHER refusal are byte-for-byte identical — only the "carries
// cost" refusal is promoted to a retire, and only in this read-only report.
//
// WHAT IT SHOWS. Per surplus lot: the batch, compartment, the stale key vs the
// purchase line's key it kept, and the lot's cost. Then the TOTAL — the ringgit
// of inventory value a costed retire would remove. Refusals are outcomes, not
// errors: a consumed, part-consumed, live-SO-bound, or MODEL-NOT-ON-ORDER lot
// (the docs/bugs/0723 nine) still stays, opt-in or not.
//
// STRICTLY READ-ONLY: three SELECTs, no writes, no transaction. Exits 0 for
// every legitimate answer. Only an unreachable DB or a query error exits non-zero.
//   DATABASE_URL=... npx tsx scripts/plan-writeoff-duplicate-sofa-lots.mjs
// tsx is not required (no TS imports) but harmless; the workflow uses node.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { planDuplicateSofaLots, variantKeyMirror } from "./lib/duplicate-sofa-lot-plan.mjs";

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

/* Identical reads to repair-duplicate-sofa-cutover-lots.mjs — the plan must see
   exactly what the retire would. */
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
      createdAt: l.created_at, consumptions: Number(l.consumptions ?? 0),
      productName: l.product_name,
    })),
    poLines: poLines.map((p) => ({
      poNumber: p.po_number, itemCode: p.item_code, itemGroup: p.item_group, variants: p.variants,
    })),
    soBindings: soBindings.map((s) => ({
      batchNo: s.batch_no, itemCode: s.item_code,
      variantKey: variantKeyMirror(s.item_group, s.variants),
    })),
    computeKey: variantKeyMirror,
    allowCostedRetire: true,
  };
}

async function main() {
  console.log(`\nWRITE-OFF PLAN — costed duplicate sofa cutover lots (docs/bugs/0721)`);
  console.log(`company ${COMPANY}${ONE_BATCH ? `, batch ${ONE_BATCH}` : ", all batches"}. READ-ONLY — nothing is written.\n`);

  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    const world = await readWorld(sql);
    console.log(`open sofa cutover lots: ${world.lots.length} (${world.lots.reduce((s, l) => s + Number(l.qty_remaining), 0)} pieces) across ${new Set(world.lots.map((l) => l.batch_no)).size} purchase orders`);

    const plan = planDuplicateSofaLots(toPlanInput(world));

    const costed = plan.retire.filter((r) => r.unitCostSen > 0);
    const zero = plan.retire.filter((r) => r.unitCostSen === 0);
    const writeOffSen = costed.reduce((s, r) => s + r.unitCostSen * r.qty, 0);

    console.log(`\nWOULD RETIRE: ${plan.retire.length} surplus lot(s) — ${costed.length} costed, ${zero.length} zero-cost.`);
    for (const r of plan.retire) {
      console.log(`   ${r.batchNo}  ${r.itemCode} x${r.qty}  ${rm(r.unitCostSen * r.qty)}`);
      console.log(`       stale   "${r.staleKey}"`);
      console.log(`       keeping "${r.currentKey}"  (the purchase line's key today)`);
    }
    console.log(`\n  INVENTORY VALUE THIS WOULD REMOVE: ${rm(writeOffSen)}  (the ${costed.length} costed lots)`);
    console.log(`  plus ${zero.length} zero-cost lot(s) that move no money.`);

    console.log(`\nREFUSED (kept — a refusal is an answer, not a failure): ${plan.refusals.length}`);
    for (const f of plan.refusals) console.log(`   ${f.batchNo} ${f.itemCode}: ${f.why}`);

    console.log(`\nNOTHING WAS WRITTEN. This is the plan the owner weighs before any write-off.`);
    console.log(`The apply that removes this value is a separate, gated tool built only if the`);
    console.log(`figure above is approved (docs/bugs/0721).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error("The plan could not be read:", e?.message ?? e); process.exit(2); });
