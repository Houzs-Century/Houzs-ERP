// Fold the Product Models a SKU merge left behind. PLAN BY DEFAULT: nothing is
// written unless MODE=apply and CONFIRM repeats the phrase this run prints.
//
// WHY. Until 2026-11-10 a SKU Master "Merge codes" never touched Models, and the
// Model merge left a folded Model's INACTIVE codes where they were. So a Model
// whose codes were all merged away stayed in Modular, switched off, still showing
// its SKU count ("AMIRA PREMUIM", 4 SKUs, after its codes merged into AMIRA
// PREMIUM). Since then both merges fold such a Model; this repairs the ones made
// before (owner decision 2026-11-10, option C).
//
// WHICH MODELS. A Model with no ACTIVE code and at least one INACTIVE code, whose
// merged codes all went into codes of exactly ONE other Model. Where a code went
// is read from the merge records, never guessed from names:
//   - audit_events 'scm.sku.merge' (every "Merge codes" on the screen), drop -> keep;
//   - data/duplicate-sku-merges.json (the Actions SKU merges), drop -> keep;
//   - data/duplicate-model-merges.json (the Actions Model merges), folded -> kept Model.
// The target is the Model the kept code sits under today. A Model with no record,
// or whose codes went to two Models, is listed and left alone.
//
// WHAT IT WRITES, per Model, in one transaction (lib/duplicate-model-merge-run.mjs
// writeModelGroup, the same writer both screens use): every INACTIVE code of the
// folded Model moved under the target (model_id, base_model), the folded Model
// switched off if it is on, and an audit_events 'scm.model.merge' row with the
// undo written first. The rules are the Model merge's own: a fold that would also
// merge, move or fill an ACTIVE code, a target that is off, a Model in another
// category, a Model still carrying sofa rows - each is refused and listed.
// WHAT IT NEVER TOUCHES: ACTIVE codes, document lines, stock, prices, AutoCount.
//
// OUTPUT: counts and Model / product codes only - no document numbers, no money -
// because this repository's Actions logs are public.
//
//   DATABASE_URL  required
//   MODE          plan (default, writes nothing) | apply
//   CONFIRM       on apply, the phrase this run prints; it carries the counts it
//                 measured, so a phrase copied from an older run cannot fire
//   COMPANY_ID    default 1
//
// RE-RUN: convergent. A folded Model ends with no code at all, so it is no longer
// a Model with an INACTIVE code and a second plan does not list it; the apply then
// writes nothing. Every UPDATE re-asserts the Model it moves a code from, so a row
// changed in between rolls that Model's transaction back.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { foldOnlyPlan } from "./lib/duplicate-model-merge-plan.mjs";
import { planModelFold, writeModelGroup, verifyModelGroup } from "./lib/duplicate-model-merge-run.mjs";
import { recordModelMergeAudit } from "./lib/duplicate-sku-merge-run.mjs";
import { orphanTargets } from "./lib/orphan-model-targets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DST = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = (process.env.CONFIRM ?? "").trim();
const CO = Number(process.env.COMPANY_ID || 1);

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!["plan", "apply"].includes(MODE)) { console.error(`REFUSED: MODE must be plan or apply, got "${MODE}".`); process.exit(2); }
if (!Number.isInteger(CO) || CO < 1) { console.error(`REFUSED: COMPANY_ID must be a positive integer.`); process.exit(2); }

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(HERE, "data", f), "utf8"));
const jarr = (xs) => JSON.stringify([...new Set(xs)]);

async function main() {
  log(`mode=${MODE} company=${CO}`);
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const orphans = await sql`
    SELECT m.id::text AS id, m.model_code, m.category::text AS category, m.active,
           array_agg(p.code ORDER BY p.code) AS codes
      FROM scm.product_models m JOIN scm.mfg_products p ON p.model_id = m.id AND p.company_id = m.company_id
     WHERE m.company_id = ${CO}
       AND NOT EXISTS (SELECT 1 FROM scm.mfg_products a WHERE a.company_id = m.company_id AND a.model_id = m.id AND a.status = 'ACTIVE')
     GROUP BY m.id, m.model_code, m.category, m.active ORDER BY m.model_code`;
  const audits = await sql`SELECT meta FROM audit_events WHERE action = 'scm.sku.merge'`;
  const skuMerges = [];
  for (const row of audits) {
    let meta = null;
    try { meta = typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta; } catch { continue; }
    if (Number(meta?.company_id) === CO && meta?.drop && meta?.keep) skuMerges.push({ drop: meta.drop, keep: meta.keep, source: "screen" });
  }
  for (const entry of Object.values(readJson("duplicate-sku-merges.json"))) {
    for (const p of entry.pairs ?? []) skuMerges.push({ drop: p.drop, keep: p.keep, source: "actions" });
  }
  const modelMerges = Object.values(readJson("duplicate-model-merges.json"))
    .flatMap((e) => (e.groups ?? []).map((g) => ({ category: g.category, keep: g.keep ?? g.newModel, drops: g.drops })));
  const keepCodes = [...new Set(skuMerges.map((m) => m.keep))];
  const keptRows = keepCodes.length === 0 ? [] : await sql`
    SELECT p.code, m.model_code, m.category::text AS category
      FROM scm.mfg_products p JOIN scm.product_models m ON m.id = p.model_id AND m.company_id = p.company_id
     WHERE p.company_id = ${CO} AND p.code = ANY(ARRAY(SELECT jsonb_array_elements_text(${jarr(keepCodes)}::text::jsonb)))`;

  const targets = orphanTargets({ orphans, skuMerges, modelMerges, keptModelOf: new Map(keptRows.map((r) => [r.code, r])) });
  const folds = [];
  const refused = [];
  for (const t of targets.filter((x) => x.into)) {
    const { world, plan, keptActive } = await planModelFold(sql, { co: CO, keep: t.into, drops: [t.model], retiring: null });
    const v = foldOnlyPlan(plan, keptActive);
    if (v.ok) folds.push({ t, plan: v.plan, world });
    else refused.push({ t, reason: v.reason });
  }
  const noRecord = targets.filter((x) => !x.into);

  log(`Models with no ACTIVE code and at least one INACTIVE code: ${orphans.length}`);
  log(`TO FOLD: ${folds.length} Model(s), ${folds.reduce((a, f) => a + f.plan.inactiveMoves.length, 0)} code(s) move`);
  for (const f of folds) log(`  FOLD "${f.t.model}" (${f.t.category}) -> "${f.t.into}": ${f.plan.inactiveMoves.length} code(s); evidence ${f.t.evidence}${f.plan.foldModels.length ? "; Model switched off" : ""}`);
  log(`REFUSED: ${refused.length}`);
  for (const r of refused) log(`  REFUSED "${r.t.model}" -> "${r.t.into}": ${r.reason}`);
  log(`LEFT ALONE: ${noRecord.length}`);
  for (const n of noRecord) log(`  LEFT "${n.model}" (${n.category}, ${n.codes} code(s)): ${n.reason}`);

  const moves = folds.reduce((a, f) => a + f.plan.inactiveMoves.length, 0);
  const phrase = `FOLD ${folds.length} ORPHAN MODELS, MOVE ${moves} CODES`;
  log(`to apply: MODE=apply CONFIRM="${phrase}"`);
  if (!APPLY) { log("PLAN ONLY - nothing was written."); await sql.end(); return; }
  if (CONFIRM !== phrase) {
    log(`REFUSED: apply needs CONFIRM="${phrase}" - measured by this run. Nothing was written.`);
    await sql.end();
    process.exit(2);
  }

  const audit = { actorId: null, actorEmail: "merge-orphan-models.mjs", requestId: null };
  const written = [];
  const problems = [];
  for (const f of folds) {
    try {
      await recordModelMergeAudit(sql, {
        audit, modelId: f.plan.keptModelId, summary: `Folding orphan Model "${f.t.model}" into "${f.t.into}"`,
        undo: { company_id: CO, moves: [], inactiveMoves: f.plan.inactiveMoves, folded: f.plan.foldModels, addSizes: [], activateKept: false, fills: [] },
      });
      const modelId = await writeModelGroup(sql, { co: CO, plan: f.plan, world: f.world, log });
      written.push({ ...f, modelId });
      log(`  WROTE "${f.t.model}" -> "${f.t.into}" (undo ids: ${f.plan.inactiveMoves.map((m) => m.id).join(", ")})`);
    } catch (e) {
      problems.push(`"${f.t.model}" ROLLED BACK, nothing of it was written: ${String(e?.message ?? e)}`);
    }
  }
  await sql.end();

  /* A connection the writes did not use. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  for (const w of written) {
    problems.push(...await verifyModelGroup(v, { co: CO, plan: w.plan, modelId: w.modelId }));
    const [shape] = await v`
      SELECT m.active, (SELECT array_agg(p.code) FROM scm.mfg_products p WHERE p.company_id = m.company_id AND p.model_id = m.id) AS left_codes
        FROM scm.product_models m WHERE m.company_id = ${CO} AND m.id::text = ${w.t.modelId}`;
    if (shape?.active !== false) problems.push(`"${w.t.model}" is still on`);
    if (Array.isArray(shape?.left_codes) && shape.left_codes.length > 0) problems.push(`"${w.t.model}" still holds ${shape.left_codes.join(", ")}`);
  }
  await v.end();
  log(`APPLIED: ${written.length} of ${folds.length} Model(s) folded`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`PROBLEM: ${p}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
