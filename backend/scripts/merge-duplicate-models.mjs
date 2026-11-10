// Fold duplicate Product Models into the one the business keeps. PLAN BY
// DEFAULT: nothing is written unless MODE=apply and CONFIRM repeats the phrase
// this run prints.
//
// The groups are not typed on the command line: TICKET names an entry in
// data/duplicate-model-merges.json, which carries them and who ruled on them.
// HC-0202 (2026-11-02): Sim's "check duplicate" sheet of mattress / bedframe
// Models. The rules live once, in lib/duplicate-model-merge-plan.mjs; two codes
// for one SKU go through the duplicate-SKU merge (lib/duplicate-sku-merge-*.mjs).
//
// WHAT IT WRITES
//   1. each duplicate-SKU pair, in its own transaction, exactly as
//      merge-duplicate-skus.mjs: lines, stock ledger, lots, racks re-keyed onto
//      the surviving code, the absorbed row set INACTIVE;
//   2. per group, in one transaction, only when all its pairs committed: the new
//      Model (when the ruling names one), the surviving SKUs moved under the kept
//      Model (model_id, base_model, a blank size_code), a survivor without a main
//      supplier given the absorbed code's main binding, its blank prices / cost
//      filled from that code, the kept Model's size pool widened and switched on,
//      the folded Models switched off;
//   3. per idle Model, in one transaction: the Model and its ACTIVE SKUs off.
// WHAT IT NEVER TOUCHES: descriptions, qty, variants, order-line prices already
// written; AutoCount - a raw SQL change queues no write-back. The moved main
// binding carries its supplier_sku, which is what AutoCount calls the item.
//
// OUTPUT: counts, Model / product / supplier codes and the row ids written (the
// undo), because this repository's Actions logs are public: no document
// numbers, no money.
//
//   DATABASE_URL  required
//   TICKET        required, a key of data/duplicate-model-merges.json (e.g. HC-0202)
//   MODE          plan (default, writes nothing) | apply
//   CONFIRM       on apply, the phrase this run prints; it carries the counts it
//                 measured, so a phrase copied from an older run cannot fire
//   COMPANY_ID    default 1
//
// RE-RUN: convergent. After an apply the absorbed codes are INACTIVE (left out of
// the size sort), the survivors already sit on the kept Model and the folded
// Models are off, so a second plan finds nothing to do and the apply writes
// nothing. Every UPDATE re-asserts the value it replaces, so a row changed in
// between fails the in-transaction count and rolls its group back.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { PRODUCT_CODE_CASCADE } from "../src/scm/lib/product-code-rename.ts";
import { planDuplicateSkuMerge } from "./lib/duplicate-sku-merge-plan.mjs";
import { readMergeColumns, readMergeWorld, applyMerge, verifyMerge, rekeyIds } from "./lib/duplicate-sku-merge-run.mjs";
import { planModelGroup, planIdleModel, confirmPhrase } from "./lib/duplicate-model-merge-plan.mjs";
import { readModelWorld, bindingFill, writeModelGroup, verifyModelGroup } from "./lib/duplicate-model-merge-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DST = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = process.env.CONFIRM ?? "";
const TICKET = (process.env.TICKET || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!["plan", "apply"].includes(MODE)) { console.error(`REFUSED: MODE must be plan or apply, got "${MODE}".`); process.exit(2); }
const BOOK = JSON.parse(fs.readFileSync(path.join(HERE, "data", "duplicate-model-merges.json"), "utf8"));
if (!BOOK[TICKET]) { console.error(`REFUSED: TICKET must be one of ${Object.keys(BOOK).join(", ")}, got "${TICKET}".`); process.exit(2); }
const ENTRY = BOOK[TICKET];

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const jarr = (xs) => JSON.stringify([...new Set(xs)]);
const anyOf = (sql, xs) => sql`ARRAY(SELECT jsonb_array_elements_text(${jarr(xs)}::text::jsonb))`;

async function main() {
  log(`mode=${MODE} ticket=${TICKET} company=${CO}; ${ENTRY.groups.length} group(s), ${(ENTRY.deactivateIfIdle ?? []).length} idle Model(s)`);
  log(`ruling: ${ENTRY.ruling}`);

  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const world = await readModelWorld(sql, { co: CO, groups: ENTRY.groups, idle: ENTRY.deactivateIfIdle ?? [] });
  const sup = new Map(world.bindings.map((b) => [b.supplier, b.supplier_name]));

  let groups = ENTRY.groups.map((group) => ({ group, plan: planModelGroup({ group, models: world.models, skus: world.skus }) }));
  const cols = await readMergeColumns(sql, PRODUCT_CODE_CASCADE);
  const allPairs = groups.flatMap((g) => g.plan.pairs.map(({ drop, keep }) => ({ drop, keep })));
  const skuWorld = await readMergeWorld(sql, { co: CO, pairs: allPairs, cascade: PRODUCT_CODE_CASCADE, cols });
  for (const m of skuWorld.missing) log(`   cascade column ${m} is not on this database - skipped`);
  // An acknowledgement counts only for a code its own group is merging away.
  const stockAcks = groups.flatMap((g) => (g.group.ackStockDivergence ?? []).filter((a) => g.plan.pairs.some((p) => p.drop === a.code)));
  const skuPlan = planDuplicateSkuMerge({ pairs: allPairs, products: skuWorld.products, refs: skuWorld.refs, stock: skuWorld.stock, stockTakeLines: skuWorld.stockTakeLines, stockAcks });
  const pairPlan = new Map(skuPlan.pairs.map((p) => [p.drop, p]));
  for (const g of groups) {
    const bad = g.plan.pairs.map((p) => pairPlan.get(p.drop)).filter((p) => p.refusals.length > 0);
    if (bad.length > 0) {
      g.plan = { ...g.plan, refusals: bad.flatMap((p) => p.refusals.map((r) => `SKU merge "${p.drop}" -> "${p.keep}": ${r}`)),
                 pairs: [], moves: [], fills: [], addSizes: [], foldModels: [], createModel: null, activateKept: false };
    }
  }
  const acting = groups.filter((g) => g.plan.refusals.length === 0);
  const idle = (ENTRY.deactivateIfIdle ?? []).map((entry) => planIdleModel({ entry, models: world.models, skus: world.skus }));

  const skuById = new Map(world.skus.map((s) => [s.id, s]));
  const skuByCode = new Map(world.skus.map((s) => [s.code, s]));
  const useTxt = (code) => { const s = skuByCode.get(code); return s ? `SO ${s.use.so}, PO ${s.use.po}, stock ${s.use.stock}, main supplier ${s.main ?? "none"}` : ""; };

  log("");
  log("PER GROUP");
  groups.forEach(({ group, plan }, i) => {
    const tag = `G${String(i + 1).padStart(2, "0")}`;
    log(`${tag} ${group.category} keep ${group.keep ? `"${group.keep}"` : `NEW "${group.newModel}"`}${plan.refusals.length ? "  REFUSED" : ""}`);
    for (const r of plan.refusals) log(`     REFUSED: ${r}`);
    if (plan.refusals.length) {
      const mains = [...new Set(world.skus.filter((s) => s.main && plan.refusals.some((r) => r.includes(`"${s.code}"`))).map((s) => s.main))];
      if (mains.length) log(`     main suppliers: ${mains.map((c) => `${c} ${sup.get(c) ?? ""}`).join("; ")}`);
    }
    for (const c of [group.keep, ...group.drops].filter((x) => x && world.near.has(x))) log(`     "${c}" not found; Models starting alike: ${world.near.get(c).join(", ") || "none"}`);
    if (plan.refusals.length) return;
    if (plan.createModel) log(`     create Model "${plan.createModel.code}" (pool copied from "${plan.createModel.template?.model_code ?? "-"}")`);
    if (plan.activateKept) log("     switch the kept Model on (it is off today)");
    for (const p of plan.pairs) {
      log(`     size ${p.size}: merge "${p.drop}" (${useTxt(p.drop)}) INTO "${p.keep}" (${useTxt(p.keep)})`);
      for (const a of pairPlan.get(p.drop)?.acknowledged ?? []) log(`       ACKNOWLEDGED stock split carried onto "${p.keep}": ${a.warehouse} ledger ${a.ledger} / open lots ${a.lots} - ${a.reason}`);
    }
    for (const m of plan.moves) log(`     size ${m.size}: move "${m.code}" under the kept Model`);
    for (const f of plan.fills) log(`     "${f.code}": take ${f.field}${f.supplier ? ` ${f.supplier} ${sup.get(f.supplier) ?? ""}` : ""} from "${f.from}"`);
    if (plan.addSizes.length) log(`     size pool + ${plan.addSizes.join("/")}`);
    for (const f of plan.foldModels) log(`     switch off Model "${f.code}"`);
    if (plan.leftInactive.length) log(`     left as they are (INACTIVE): ${plan.leftInactive.join(", ")}`);
  });

  log("");
  log("IDLE MODELS (switch off with their ACTIVE SKUs when no stock and no open SO line)");
  for (const x of idle) log(`   "${x.label}": ${x.refusals.length ? `stays on - ${x.refusals.join("; ")}` : x.modelId ? `off, with ${x.skuIds.length} SKU(s)` : `already off; ${x.skuIds.length} SKU(s) off`}`);

  const actingPairs = acting.flatMap((g) => g.plan.pairs.map((p) => pairPlan.get(p.drop)));
  const t = {
    groups: acting.length,
    pairs: actingPairs.length,
    moves: acting.reduce((a, g) => a + g.plan.moves.length, 0),
    fills: acting.reduce((a, g) => a + g.plan.fills.length, 0),
    folds: acting.reduce((a, g) => a + g.plan.foldModels.length + (g.plan.createModel ? 1 : 0), 0),
    idleModels: idle.filter((x) => x.modelId).length,
    idleSkus: idle.reduce((a, x) => a + x.skuIds.length, 0),
  };
  const rekeyRows = actingPairs.reduce((a, p) => a + p.rekey.reduce((b, r) => b + r.rows, 0), 0);
  const units = actingPairs.reduce((a, p) => a + p.unitsMoved, 0);
  const phrase = confirmPhrase(t);
  log("");
  log(`TOTALS groups ${groups.length} (acting ${t.groups}, refused ${groups.length - t.groups}); SKU merges ${t.pairs} (re-key ${rekeyRows} row(s), move ${units} unit(s)); SKU moves ${t.moves}; fills ${t.fills}; Models created+folded ${t.folds}; idle off ${t.idleModels} Model(s) / ${t.idleSkus} SKU(s)`);
  log(`to apply: MODE=apply CONFIRM="${phrase}"`);

  if (!APPLY) { log("PLAN ONLY - nothing was written."); await sql.end(); return; }
  if (CONFIRM !== phrase) {
    log(`REFUSED: apply needs CONFIRM="${phrase}" - measured by this run. Nothing was written.`);
    await sql.end();
    process.exit(2);
  }

  log("");
  log("UNDO (before any write)");
  for (const p of actingPairs) {
    for (const a of p.acknowledged ?? []) log(`   acknowledged "${p.drop}" ${a.warehouse}: ledger ${a.ledger} / open lots ${a.lots} - ${a.reason}`);
    for (const r of p.rekey) log(`   undo pair "${p.drop}" scm.${r.table}.${r.col} = '${p.drop}' WHERE id IN ${JSON.stringify(rekeyIds(skuWorld, p, r))}`);
    if (p.retire) log(`   undo pair "${p.drop}" scm.mfg_products ${p.dropRowId} status ACTIVE`);
  }
  for (const { plan } of acting) {
    for (const m of plan.moves) { const s = skuById.get(m.id); log(`   undo move ${m.id}: model_id ${s.model_id}, base_model ${JSON.stringify(s.base_model)}, size_code ${JSON.stringify(s.size_code)}`); }
    for (const f of plan.fills.filter((x) => x.field === "main supplier")) { const b = bindingFill(world, f); log(`   undo main supplier on "${f.code}": binding ${b.bindingId} ${b.kind === "star" ? "is_main_supplier false" : `item_code '${f.from}'`}`); }
    for (const f of plan.fills.filter((x) => x.field !== "main supplier")) log(`   undo fill "${f.code}".${f.field}: back to blank`);
    const kept = world.models.find((m) => m.id === plan.keptModelId);
    if (kept && (plan.addSizes.length || plan.activateKept)) log(`   undo Model ${kept.id}: allowed_options.sizes ${JSON.stringify(kept.allowed_options?.sizes ?? null)}, active ${kept.active}`);
    for (const f of plan.foldModels) log(`   undo Model ${f.id}: active true`);
  }
  for (const x of idle.filter((y) => y.modelId || y.skuIds.length)) log(`   undo idle "${x.label}": Model ${x.modelId ?? "-"} active true; SKUs ${JSON.stringify(x.skuIds)} ACTIVE`);

  const { committed, problems, rekeyed } = await applyMerge(sql, {
    co: CO, plan: { pairs: actingPairs }, world: skuWorld, cascade: PRODUCT_CODE_CASCADE, audit: null,
  });
  log(`WRITTEN SKU merges: ${rekeyed} row(s) re-keyed, ${committed.length} of ${actingPairs.filter((p) => p.rekey.length || p.retire).length} pair(s) committed`);
  const done = new Set(committed.map((p) => p.drop));

  const groupsDone = [];
  for (const g of acting) {
    const { plan } = g;
    if (plan.pairs.some((p) => !done.has(p.drop) && (pairPlan.get(p.drop).rekey.length || pairPlan.get(p.drop).retire))) {
      problems.push(`group "${plan.label}" NOT written: one of its SKU merges rolled back`);
      continue;
    }
    try {
      const modelId = await writeModelGroup(sql, { co: CO, plan, world, log });
      groupsDone.push({ ...g, modelId });
    } catch (e) {
      problems.push(`group "${plan.label}" ROLLED BACK, its Model writes did not land (its SKU merges did): ${String(e?.message ?? e)}`);
    }
  }
  log(`WRITTEN groups: ${groupsDone.length} of ${acting.length}`);

  const idleDone = [];
  for (const x of idle.filter((y) => y.modelId || y.skuIds.length)) {
    try {
      await sql.begin(async (tx) => {
        if (x.modelId) {
          const r = await tx`UPDATE scm.product_models SET active = false, updated_at = now() WHERE company_id = ${CO} AND id::text = ${x.modelId} AND active = true RETURNING id`;
          if (r.length !== 1) throw new Error("the Model was not on any more");
        }
        const r = await tx`UPDATE scm.mfg_products SET status = 'INACTIVE', updated_at = now()
                            WHERE company_id = ${CO} AND id::text = ANY(${anyOf(tx, x.skuIds)}) AND status = 'ACTIVE' RETURNING id`;
        if (r.length !== x.skuIds.length) throw new Error(`switched off ${r.length} of ${x.skuIds.length} SKU(s) - one changed since the plan`);
      });
      idleDone.push(x);
    } catch (e) {
      problems.push(`idle "${x.label}" ROLLED BACK: ${String(e?.message ?? e)}`);
    }
  }
  log(`WRITTEN idle: ${idleDone.length} Model(s)`);
  await sql.end();

  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  problems.push(...await verifyMerge(v, { co: CO, committed, world: skuWorld }));
  for (const { plan, modelId } of groupsDone) problems.push(...await verifyModelGroup(v, { co: CO, plan, modelId }));
  for (const x of idleDone) {
    const [n] = await v`SELECT COUNT(*)::int AS n FROM scm.mfg_products WHERE company_id = ${CO} AND id::text = ANY(${anyOf(v, x.skuIds)}) AND status = 'ACTIVE'`;
    if (n.n !== 0) problems.push(`idle "${x.label}": ${n.n} SKU(s) still ACTIVE`);
  }
  await v.end();
  if (problems.length > 0) {
    for (const x of problems) log(`   VERIFY FAILED: ${x}`);
    log("FAILED. The UNDO lists above cover every write that landed.");
    process.exit(1);
  }
  log("VERIFIED on a fresh connection: merged codes INACTIVE and re-keyed, survivors under their kept Model, pools widened, folded and idle Models off.");
  log("NEXT: run 'Recompute SO stock allocation (DRY-RUN gated)'. A direct SQL write does not recompute the allocation projection (docs/bugs/0675).");
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://<redacted>"));
  process.exit(1);
});
