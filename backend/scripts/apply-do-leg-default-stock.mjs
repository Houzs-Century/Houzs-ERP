// Put right the delivery lines the invented sofa leg height stranded
// (docs/bugs/0722). The PLAN half (plan-do-leg-default-stock.mjs, #3594) reports
// what this would do; this writes it. DRY-RUN by default; APPLY needs both
// APPLY=1 and CONFIRM.
//
// WHAT WENT WRONG (traced, docs/bugs/0722). `SoLineCard`'s heal effect seeded a
// blank sofa Leg Height with "Default"; the card is SHARED, so it ran on the
// DELIVERY ORDER form too, and `computeVariantKey` emits `legheight=` for a
// sofa. Three DOs shipped on "Ship anyway" (HC-DO-2609-004, -009, -011) asking
// the stock ledger about a bucket that had `legheight=default` — which NO lot
// carries. The FIFO trigger matched no lot, so the OUT movement consumed nothing
// and cost nothing. Result: stock overstated by 5 pieces, and three sales with
// no COGS. #3296 stopped it recurring; these five were left for this tool.
//
// THE INVENTED KEY LIVES IN THREE PLACES, and the fix aligns all three:
//   - the DELIVERY LINE variants        (legHeight: "Default")  -> strip it
//   - the phantom OUT movement          (…legheight=default, 0 consumptions) -> delete it
//   - the LOT                           (never had it)          -> untouched
//
// REUSE, NOT REPLICATION (the restamp-do-actual-cost.mjs discipline). Once the
// line variants are clean and the phantom OUT is gone, the repair is a normal
// re-ship: the CANONICAL `resyncInventoryForDo` (delivery-orders-mfg.ts) books
// the missing OUT at the clean key — the FIFO trigger consumes the real lot at
// its real cost — and calls `restampDoActualCost` itself; then the canonical
// `restampSiFromDo` (recost.ts) copies that onto the Sales Invoice. This script
// contains NO stock or costing logic of its own. It talks to those functions
// through lib/pgrest-shim.mjs (an sb-shaped builder over DATABASE_URL) and runs
// under tsx for the TS imports.
//
// WHY DELETE, NOT REVERSE, THE PHANTOM OUT. A reversing IN is how a REAL ship is
// unwound — it returns the stock the OUT consumed. This OUT consumed nothing
// (0 inventory_lot_consumptions), so a reversing IN would MINT a 0-cost phantom
// lot. Deleting a movement that has no consumption rows orphans nothing. The
// tool REFUSES to touch any movement that has even one consumption — that is a
// real ship and belongs to the reversal path, not here.
//
// WHY NOT deductInventoryForDo. Its idempotency guard no-ops when ANY OUT exists
// for the DO, and these DOs keep their pillow lines' real OUTs — so it would
// skip the sofa re-book. resyncInventoryForDo nets per bucket, and after the
// phantom OUT is deleted AND the line key stripped, the polluted bucket is gone
// from both movements and lines, so resync writes exactly one clean +1 OUT and
// no phantom reversing IN.
//
// SAFETY. Every value bound, never interpolated. Per-DO work runs so a failure
// on one cannot half-fix another. Verified on a FRESH connection afterwards: the
// session that wrote is the worst witness that the write landed.
//
// RUN. DRY-RUN (default): DATABASE_URL only, reads + prints the plan, writes
//   nothing. APPLY: APPLY=1 CONFIRM="STAMP THE FIVE STRANDED LINES" — same
//   DATABASE_URL, runs the canonical functions and verifies the shape.
//   Under tsx (the TS imports): npx tsx scripts/apply-do-leg-default-stock.mjs
//
// RE-RUN: convergent. A repaired line has its variants stripped of legHeight and
//   its phantom OUT deleted, so the second run's scan (OUT movements carrying
//   legheight=default) finds nothing for it and reports 0 to repair. It can
//   never re-strip or re-ship a line, because the invented key it keys on is
//   already gone. A second APPLY with nothing in scope writes nothing.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { planDoLegDefaultRepair, LEG_DEFAULT_FRAGMENT } from "./lib/do-leg-default-repair-plan.mjs";

const CONFIRM_PHRASE = "STAMP THE FIVE STRANDED LINES";
const WANTS_APPLY = process.env.APPLY === "1";
// The ONLY comparison of CONFIRM lives in the guard below, adjacent to its exit,
// so `APPLY` here is simply "wanted apply and got past the guard" — past it, a
// true WANTS_APPLY means the phrase matched.
const APPLY = WANTS_APPLY;
const ACTOR = (process.env.ACTOR || "repair:do-leg-default-0722").trim();

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);
const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toFixed(2)}`;

function fromDevVars(field) {
  try {
    return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1];
  } catch {
    return undefined;
  }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
// The refusal lives AT the comparison (release-discipline scans for exactly
// this): CONFIRM must equal the spelled-out phrase before any write, and the
// exit is adjacent so a reader — and the static check — can see it guards.
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was read or written.`);
  process.exit(2);
}

/** Read the world the planner needs: every OUT movement carrying the invented
 *  key, the open lots that could carry the corrected keys, and how many
 *  consumptions each movement already has. */
async function readWorld(pg) {
  const movements = await pg`
    SELECT m.id::text AS id, m.source_doc_no, m.source_doc_id::text AS source_doc_id,
           m.item_code, m.qty, m.warehouse_id::text AS warehouse_id,
           COALESCE(m.variant_key,'') AS variant_key, m.unit_cost_sen
      FROM scm.inventory_movements m
     WHERE m.movement_type = 'OUT'
       AND m.variant_key ILIKE ${"%" + LEG_DEFAULT_FRAGMENT + "%"}
     ORDER BY m.source_doc_no, m.item_code`;

  const itemCodes = [...new Set(movements.map((m) => m.item_code))];
  const lots = itemCodes.length === 0 ? [] : await pg`
    SELECT l.id::text AS id, l.item_code, COALESCE(l.variant_key,'') AS variant_key,
           l.warehouse_id::text AS warehouse_id, l.qty_remaining, l.unit_cost_sen,
           l.batch_no
      FROM scm.inventory_lots l
     WHERE l.item_code = ANY(${itemCodes}) AND l.qty_remaining > 0`;

  const consumed = movements.length === 0 ? [] : await pg`
    SELECT c.movement_id::text AS movement_id, count(*)::int AS n
      FROM scm.inventory_lot_consumptions c
     WHERE c.movement_id = ANY(${movements.map((m) => m.id)})
     GROUP BY c.movement_id`;
  const consumptionCountByMovementId = Object.fromEntries(consumed.map((r) => [r.movement_id, r.n]));

  return { movements, lots, consumptionCountByMovementId };
}

function toPlanInput({ movements, lots, consumptionCountByMovementId }) {
  return {
    movements: movements.map((m) => ({
      id: m.id, sourceDocNo: m.source_doc_no, itemCode: m.item_code,
      qty: Number(m.qty), warehouseId: m.warehouse_id, variantKey: m.variant_key,
      unitCostSen: Number(m.unit_cost_sen ?? 0),
    })),
    lots: lots.map((l) => ({
      id: l.id, itemCode: l.item_code, variantKey: l.variant_key,
      warehouseId: l.warehouse_id, qtyRemaining: Number(l.qty_remaining),
      unitCostSen: Number(l.unit_cost_sen ?? 0), batchNo: l.batch_no,
    })),
    consumptionCountByMovementId,
  };
}

async function main() {
  notice(`\nDO LEG-DEFAULT STRANDED LINES — ${APPLY ? "APPLY (writes will be COMMITTED)" : "DRY-RUN (nothing is written)"}`);
  const pg = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

  const world = await readWorld(pg);
  const plan = planDoLegDefaultRepair(toPlanInput(world));

  notice(`\n${world.movements.length} OUT movement(s) carry ${LEG_DEFAULT_FRAGMENT}.`);
  notice(`WOULD REPAIR: ${plan.repairs.length} line(s), ${plan.totals.piecesToConsume} piece(s), ${rm(plan.totals.costToStampSen)} of COGS.`);
  for (const r of plan.repairs) {
    notice(`   ${r.sourceDocNo}  ${r.itemCode} x${r.qty}  ${r.fromKey}  ->  ${r.toKey}  (${rm(r.totalCostSen)})`);
  }
  if (plan.refusals.length) {
    warn(`REFUSED: ${plan.refusals.length}`);
    for (const f of plan.refusals) warn(`   ${f.sourceDocNo} ${f.itemCode} [${f.reason}] ${f.detail}`);
  }

  if (plan.repairs.length === 0) {
    notice("\nNothing to repair. Done.");
    await pg.end();
    return;
  }

  if (!APPLY) {
    notice(`\nDRY-RUN — nothing was written. To apply:\n  APPLY=1 CONFIRM="${CONFIRM_PHRASE}" npx tsx scripts/apply-do-leg-default-stock.mjs`);
    await pg.end();
    return;
  }

  /* ── Write, reusing the canonical functions through the shim ──────────────── */
  const { resyncInventoryForDo } = await import("../src/scm/routes/delivery-orders-mfg.ts");
  const { restampSiFromDo } = await import("../src/scm/lib/recost.ts");
  const { pgrestShim } = await import("./lib/pgrest-shim.mjs");
  const sb = pgrestShim(pg, "scm");
  const assertNoShimGaps = (ctx) => {
    if (sb.__gaps.length === 0) return;
    console.error(`SHIM GAP during ${ctx} — the canonical function called a method the shim does not implement; aborting so a silent skip can never read as success:`);
    for (const g of sb.__gaps) console.error(`  ${g}`);
    process.exit(1);
  };

  /* Group the plan by DO. Each DO is one unit of work. */
  const byDo = new Map();
  for (const r of plan.repairs) {
    const g = byDo.get(r.sourceDocNo) ?? { docNo: r.sourceDocNo, docId: null, movementIds: [], itemCodes: [] };
    g.movementIds.push(r.movementId);
    g.itemCodes.push(r.itemCode);
    byDo.set(r.sourceDocNo, g);
  }
  /* Resolve each DO's id from the movements we already read (source_doc_id). */
  for (const m of world.movements) {
    const g = byDo.get(m.source_doc_no);
    if (g && !g.docId) g.docId = m.source_doc_id;
  }

  let doneDos = 0;
  const failures = [];
  for (const g of byDo.values()) {
    try {
      if (!g.docId) throw new Error(`no source_doc_id for ${g.docNo}`);

      /* 1. Strip the invented leg height from the stranded DO lines. Raw pg:
            the shim has no delete and this is a jsonb key removal, not a
            costing decision. Scope: this DO's lines whose item_code is in the
            plan AND whose variants still carry legHeight. */
      const stripped = await pg`
        UPDATE scm.delivery_order_items
           SET variants = variants - 'legHeight'
         WHERE delivery_order_id = ${g.docId}::uuid
           AND item_code = ANY(${g.itemCodes})
           AND variants ? 'legHeight'
        RETURNING id`;

      /* 2. Delete the phantom OUT movements. Safe: the planner admitted them
            only with ZERO consumptions, and we re-assert it here inside the
            same run so a race cannot slip a consumed movement through. */
      const stillZero = await pg`
        SELECT m.id
          FROM scm.inventory_movements m
         WHERE m.id = ANY(${g.movementIds})
           AND NOT EXISTS (SELECT 1 FROM scm.inventory_lot_consumptions c WHERE c.movement_id = m.id)`;
      if (stillZero.length !== g.movementIds.length) {
        throw new Error(`a phantom movement gained a consumption since the plan was read — refusing ${g.docNo}`);
      }
      await pg`DELETE FROM scm.inventory_movements WHERE id = ANY(${g.movementIds})`;

      /* 3. Re-ship: the canonical resync books the missing OUT at the clean key
            (FIFO consumes the real lot at real cost) and restamps the DO lines. */
      await resyncInventoryForDo(sb, g.docId, ACTOR);
      assertNoShimGaps(`resyncInventoryForDo(${g.docNo})`);

      /* 4. Cascade the corrected cost onto the Sales Invoice. */
      await restampSiFromDo(sb, g.docId);
      assertNoShimGaps(`restampSiFromDo(${g.docNo})`);

      notice(`   ${g.docNo}: stripped ${stripped.length} line(s), deleted ${g.movementIds.length} phantom OUT(s), re-shipped + restamped.`);
      doneDos++;
    } catch (e) {
      failures.push({ docNo: g.docNo, error: String(e?.message ?? e) });
    }
  }
  notice(`\nWRITTEN: ${doneDos} of ${byDo.size} delivery order(s); failures ${failures.length}`);
  for (const f of failures) warn(`   FAILED ${f.docNo}: ${f.error}`);
  await pg.end();

  /* ── Verify on a FRESH connection ────────────────────────────────────────
     What must be true afterwards: no OUT movement carries the invented key any
     more, every repaired DO now has a costed OUT + a consumption for each sofa
     line, and the DO lines carry a nonzero cost. */
  const v = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  const leftover = await v`
    SELECT count(*)::int AS n FROM scm.inventory_movements
     WHERE movement_type = 'OUT' AND variant_key ILIKE ${"%" + LEG_DEFAULT_FRAGMENT + "%"}
       AND source_doc_no = ANY(${[...byDo.keys()]})`;
  const docIds = [...byDo.values()].map((g) => g.docId).filter(Boolean);
  const uncostedLines = docIds.length === 0 ? [] : await v`
    SELECT di.delivery_order_id::text AS do_id, di.item_code
      FROM scm.delivery_order_items di
     WHERE di.delivery_order_id = ANY(${docIds}::uuid[])
       AND di.item_code = ANY(${[...new Set(plan.repairs.map((r) => r.itemCode))]})
       AND COALESCE(di.line_cost_centi, 0) = 0`;
  await v.end();

  notice("\nVERIFY (fresh connection):");
  notice(`   OUT movements still carrying the invented key: ${leftover[0].n} (want 0)`);
  notice(`   repaired sofa lines still at zero cost: ${uncostedLines.length} (want 0)`);
  for (const l of uncostedLines) warn(`   STILL ZERO: ${l.do_id} ${l.item_code}`);

  if (failures.length > 0 || Number(leftover[0].n) !== 0 || uncostedLines.length > 0) {
    console.error("\nFAILED — see above. What DID land is reversible: the re-ship OUT nets against a reversing IN (cancel path), and a deleted phantom carried no consumption to restore.");
    process.exit(1);
  }
  notice("\nOK — every stranded line re-shipped at its real cost; no invented key remains.");
  notice("If the SO stock allocation looks stale afterwards, run the SO allocation recompute (a direct write does not trigger a projection recompute, docs/bugs/0675).");
}

main().catch((e) => { console.error(e); process.exit(1); });
