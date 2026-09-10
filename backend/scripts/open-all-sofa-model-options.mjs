#!/usr/bin/env node
// Open EVERY sofa `product_models.allowed_options` under company HOUZS to the
// full pool — every compartment, every seat size, every leg height, every
// special, every fabric colour. Owner 2026-09-10: 「帮我把全部 sofa module 的
// 那些 special order 开放到完，还有全部颜色、variant 全部开放到完」/「帮我
// 操作 把全部东西 open 给全部 module」.
//
// The frontend already auto-fills compartments/sizes/leg_heights/specials
// when a Model has none (ProductModelDetail.tsx `fillIfEmpty`), but it DOES
// NOT auto-fill fabrics — every sofa Model whose `allowed_options.fabrics`
// was a hand-curated whitelist keeps that whitelist forever, which is why
// HR805-10 / HR805-90 (Active in the library) never surfaced in the SO line
// colour picker for Model 2376 (docs/bugs/). This script writes the FULL
// pool for every key so a fabric added to the library becomes selectable on
// every Model without a per-Model touch — matching the 2990 stance.
//
// SCOPE. company_id = HOUZS, category = 'SOFA', active = true. 2990 rows are
// out of scope (different company_id). Bedframe / Mattress models are out of
// scope for this run — sofa is the module the owner walked with today.
//
// UNION, not replace: `allowed_options` gains any pool entry it lacks; any
// custom Model-specific entries beyond the pool are preserved. The frontend
// treats `allowed_options.<key>` as a WHITELIST when non-empty, so a
// preserved custom code keeps working; empty stays "no restriction" as
// before (mfg-pricing.ts + allowed-options-check.ts).
//
// MODE=dry-run (default) runs the whole transaction and rolls it back and
// prints the delta model-by-model. MODE=apply requires
// CONFIRM="I HAVE REVIEWED THE DRY-RUN".
//
// RE-RUN: convergent. A second run with the same pools writes zero deltas
// and the summary reports 0 apply / N noop.
import postgres from "postgres";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const APPLY = MODE === "apply" && process.env.CONFIRM === CONFIRM_PHRASE;
if (MODE === "apply" && !APPLY) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}". Aborting.`);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const KEYS = ["compartments", "sizes", "leg_heights", "specials", "fabrics"];

function poolValue(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.value === "string") return v.value;
  return null;
}
function dedupe(arr) { return [...new Set(arr.filter((x) => x != null && x !== ""))]; }
function unionInto(existing, pool) {
  const cur = Array.isArray(existing) ? existing : [];
  const have = new Set(cur);
  const add = pool.filter((v) => !have.has(v));
  return { next: [...cur, ...add], added: add };
}

async function main() {
  const [co] = await sql`SELECT id, code FROM public.companies WHERE code = ${"HOUZS"}`;
  if (!co) throw new Error("company HOUZS not found");
  const cid = co.id;
  note(`MODE=${MODE} company=HOUZS(${cid}) scope=sofa`);

  await sql.begin(async (tx) => {
    const now = new Date().toISOString();

    const [cfg] = await tx`SELECT config FROM scm.maintenance_config_history
      WHERE company_id = ${cid} AND scope = 'master' AND effective_from <= CURRENT_DATE
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
    const maint = cfg?.config ?? {};
    const compsPool = dedupe((maint.sofaCompartments ?? []).map(poolValue));
    const sizesPool = dedupe((maint.sofaSizes ?? ["24", "26", "28", "30", "32", "35"]).map(poolValue));
    const legsPool  = dedupe((maint.sofaLegHeights ?? []).map(poolValue));

    const addonRows = await tx`SELECT code FROM scm.special_addons
      WHERE company_id = ${cid} AND active = true AND ${"SOFA"} = ANY(categories)
      ORDER BY sort_order NULLS LAST, code`;
    const specialsPool = dedupe(addonRows.map((r) => r.code));

    const fabricRows = await tx`SELECT label FROM scm.fabric_library
      WHERE company_id = ${cid} AND active = true ORDER BY sort_order NULLS LAST, label`;
    const fabricsPool = dedupe(fabricRows.map((r) => r.label));

    const pool = { compartments: compsPool, sizes: sizesPool, leg_heights: legsPool, specials: specialsPool, fabrics: fabricsPool };
    note(`pools loaded: compartments=${compsPool.length} sizes=${sizesPool.length} leg_heights=${legsPool.length} specials=${specialsPool.length} fabrics=${fabricsPool.length}`);
    for (const k of KEYS) if (pool[k].length === 0) note(`  !! pool ${k} is EMPTY — every Model's ${k} will be left as-is on this run`);

    const models = await tx`SELECT id, model_code, name, allowed_options
      FROM scm.product_models
      WHERE company_id = ${cid} AND category = 'SOFA' AND active = true
      ORDER BY model_code`;
    note(`sofa models under HOUZS: ${models.length}`);

    let modelsChanged = 0;
    const totals = Object.fromEntries(KEYS.map((k) => [k, 0]));

    for (const m of models) {
      const opts = { ...(m.allowed_options ?? {}) };
      const perKeyAdd = {};
      let dirty = false;
      for (const k of KEYS) {
        if (pool[k].length === 0) continue;
        const { next, added } = unionInto(opts[k], pool[k]);
        if (added.length > 0) {
          opts[k] = next;
          perKeyAdd[k] = added.length;
          totals[k] += added.length;
          dirty = true;
        }
      }
      if (!dirty) continue;
      modelsChanged += 1;
      const delta = Object.entries(perKeyAdd).map(([k, n]) => `${k}+${n}`).join(" ");
      note(`  ${m.model_code} "${m.name}"  ${delta}`);
      if (APPLY) {
        await tx`UPDATE scm.product_models
          SET allowed_options = ${tx.json(opts)}, updated_at = ${now}
          WHERE id = ${m.id}`;
      }
    }

    note("");
    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}): models_touched=${modelsChanged}/${models.length} additions=${JSON.stringify(totals)}`);

    if (APPLY) {
      const [{ n }] = await tx`SELECT COUNT(*)::int AS n FROM scm.product_models
        WHERE company_id = ${cid} AND category = 'SOFA' AND active = true
          AND jsonb_typeof(allowed_options->'fabrics') = 'array'
          AND jsonb_array_length(allowed_options->'fabrics') >= ${fabricsPool.length}`;
      note(`shape check: ${n}/${models.length} sofa models now carry >= ${fabricsPool.length} fabrics (the full pool size)`);
    }

    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => {
    if (e.message !== "DRY-RUN-ROLLBACK") throw e;
    note(`DRY-RUN complete: transaction rolled back, nothing written. MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
  });
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
