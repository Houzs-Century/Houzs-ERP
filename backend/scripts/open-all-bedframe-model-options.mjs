#!/usr/bin/env node
// Open EVERY bedframe + mattress `product_models.allowed_options` under HOUZS
// to the full pool for each key. Owner 2026-09-10, immediately after the sofa
// open-all landed: 「bedframe 的 special order 没有全开？」 and 「我看了这一篇
// special 明明是开完的，可是为什么我去开单的时候，我的 special 却是 none 的呢?」
//
// The sofa apply (backend/scripts/open-all-sofa-model-options.mjs) scoped
// `category = 'SOFA'`, so bedframe + mattress Models kept whatever narrow
// whitelist they had. On the SO amendment picker that reads
// `allowed_options.<key>` as a WHITELIST when non-empty, a bedframe Model
// whose `allowed_options.specials` is empty (or missing entries) shows
// "None" in Special Order even though the Model detail page auto-fills
// the pool on load — that auto-fill is LOCAL until the operator hits Save
// (ProductModelDetail.tsx:222-236 `fillIfEmpty`), and nobody had.
//
// SCOPE. company_id = HOUZS. Two categories:
//   * BEDFRAME — keys: sizes / divan_heights / total_heights / gaps /
//                leg_heights / specials
//   * MATTRESS — keys: sizes
// SOFA is NOT touched here (the sofa apply already opened it). Compartments
// are NOT a bedframe/mattress key.
//
// UNION, not replace. Any Model-specific code beyond the pool is preserved.
// Empty pool for a key leaves that key alone.
//
// MODE=dry-run (default) runs the whole transaction and rolls back and prints
// the per-Model delta. MODE=apply also needs
// CONFIRM="I HAVE REVIEWED THE DRY-RUN".
//
// RE-RUN: convergent — a second apply writes zero.
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

const BEDFRAME_KEYS = ["sizes", "divan_heights", "total_heights", "gaps", "leg_heights", "specials"];
const MATTRESS_KEYS = ["sizes"];

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
  const added = pool.filter((v) => !have.has(v));
  return { next: [...cur, ...added], added };
}

async function main() {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = ${"HOUZS"}`;
  if (!co) throw new Error("company HOUZS not found");
  const cid = co.id;
  note(`MODE=${MODE} company=HOUZS(${cid}) scope=bedframe+mattress`);

  await sql.begin(async (tx) => {
    const now = new Date().toISOString();

    const [cfg] = await tx`SELECT config FROM scm.maintenance_config_history
      WHERE company_id = ${cid} AND scope = 'master' AND effective_from <= CURRENT_DATE
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
    const maint = cfg?.config ?? {};

    const bfSizes = dedupe((maint.bedframeSizes ?? ["S", "SS", "Q", "K", "SK", "SP"]).map(poolValue));
    const divans  = dedupe((maint.divanHeights ?? []).map(poolValue));
    const totalH  = dedupe((maint.totalHeights ?? []).map(poolValue));
    const gaps    = dedupe((maint.gaps ?? []).map(poolValue));
    const legs    = dedupe((maint.legHeights ?? []).map(poolValue));
    const matSizes = dedupe((maint.mattressSizes ?? ["S", "SS", "Q", "K", "SK", "SP"]).map(poolValue));

    const addonRows = await tx`SELECT code FROM scm.special_addons
      WHERE company_id = ${cid} AND active = true AND ${"BEDFRAME"} = ANY(categories)
      ORDER BY sort_order NULLS LAST, code`;
    const bfSpecials = dedupe(addonRows.map((r) => r.code));

    const bfPool = { sizes: bfSizes, divan_heights: divans, total_heights: totalH, gaps, leg_heights: legs, specials: bfSpecials };
    const matPool = { sizes: matSizes };

    note(`bedframe pools: sizes=${bfSizes.length} divan_heights=${divans.length} total_heights=${totalH.length} gaps=${gaps.length} leg_heights=${legs.length} specials=${bfSpecials.length}`);
    note(`mattress pools: sizes=${matSizes.length}`);

    async function processCategory(category, keys, pool) {
      const models = await tx`SELECT id, model_code, name, allowed_options
        FROM scm.product_models
        WHERE company_id = ${cid} AND category = ${category} AND active = true
        ORDER BY model_code`;
      note(`${category} models under HOUZS: ${models.length}`);
      let modelsChanged = 0;
      const totals = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const m of models) {
        const opts = { ...(m.allowed_options ?? {}) };
        const perKeyAdd = {};
        let dirty = false;
        for (const k of keys) {
          const p = pool[k];
          if (!p || p.length === 0) continue;
          const { next, added } = unionInto(opts[k], p);
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
        note(`  ${category} ${m.model_code} "${m.name}"  ${delta}`);
        if (APPLY) {
          await tx`UPDATE scm.product_models
            SET allowed_options = ${tx.json(opts)}, updated_at = ${now}
            WHERE id = ${m.id}`;
        }
      }
      note(`  ${category} RESULT: models_touched=${modelsChanged}/${models.length} additions=${JSON.stringify(totals)}`);
    }

    await processCategory("BEDFRAME", BEDFRAME_KEYS, bfPool);
    await processCategory("MATTRESS", MATTRESS_KEYS, matPool);

    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => {
    if (e.message !== "DRY-RUN-ROLLBACK") throw e;
    note(`DRY-RUN complete: transaction rolled back, nothing written. MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
  });

  if (APPLY) {
    const verify = postgres(url, { ssl: "require", prepare: false, max: 1 });
    try {
      const [co2] = await verify`SELECT id FROM public.companies WHERE code = ${"HOUZS"}`;
      const cid2 = co2.id;
      const rows = await verify`SELECT model_code, category, allowed_options
        FROM scm.product_models
        WHERE company_id = ${cid2} AND category IN ('BEDFRAME','MATTRESS') AND active = true`;
      const [[addons]] = await Promise.all([
        verify`SELECT COUNT(*)::int AS n FROM scm.special_addons WHERE company_id = ${cid2} AND active AND ${"BEDFRAME"} = ANY(categories)`,
      ]);
      const wantBfSpecials = addons.n;
      const bad = [];
      for (const r of rows) {
        const ao = r.allowed_options ?? {};
        if (r.category === "BEDFRAME" && wantBfSpecials > 0 && (!Array.isArray(ao.specials) || ao.specials.length < wantBfSpecials)) {
          bad.push(`${r.model_code}(specials=${(ao.specials ?? []).length}/${wantBfSpecials})`);
        }
      }
      if (bad.length) throw new Error(`fresh-connection shape check FAILED — ${bad.length} bedframe model(s): ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? " …" : ""}`);
      note(`fresh-connection shape check: every bedframe model covers ${wantBfSpecials} specials; ${rows.length} bedframe+mattress models total.`);
    } finally {
      await verify.end({ timeout: 5 });
    }
  }
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
