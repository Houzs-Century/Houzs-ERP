#!/usr/bin/env node
// Owner 2026-08-10: "1B 要分" — the unsided 1B SKUs from opener round 2 become
// the sided pair 1B(LHF)/1B(RHF) on 8030/8060/8069/9050/9058. Deletes the
// unsided 1B (created 2026-08-10, zero SO references), mints the pair
// (skip_exists if the sided convention already exists), fixes
// allowed_options and appends the sided codes to the pool. Gated as usual.
//
// RE-RUN: inert. The SKU deletes/creates and the allowed_options rewrite all test the current state first; a second run finds the target shape already in place.
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const APPLY = MODE === "apply" && process.env.CONFIRM === "I HAVE REVIEWED THE DRY-RUN";
if (MODE === "apply" && !APPLY) { console.error("apply needs CONFIRM"); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const MODELS = ["8030", "8060", "8069", "9050", "9058"];
const BN = { "8069": ["1B", "2B"] }; // 8069 also got an unsided 2B

async function main() {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = ${"HOUZS"}`;
  const cid = co.id;
  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    let del = 0, mint = 0, skip = 0;
    const poolNeed = new Set();
    for (const m of MODELS) {
      const [mr] = await tx`SELECT id, name, allowed_options FROM scm.product_models
        WHERE company_id = ${cid} AND model_code = ${m} AND category = 'SOFA'`;
      if (!mr) { note(`  !! model ${m} missing`); continue; }
      for (const b of (BN[m] ?? ["1B"])) {
      const un = `${m}-${b}`;
      const [p] = await tx`SELECT id, created_at FROM scm.mfg_products WHERE company_id = ${cid} AND code = ${un}`;
      if (p) {
        const [ref] = await tx`SELECT 1 AS x FROM scm.mfg_sales_order_items WHERE item_code = ${un} LIMIT 1`;
        if (ref) note(`  !! ${un} referenced — kept`);
        else if (new Date(p.created_at) < new Date("2026-08-09T20:00:00Z")) note(`  !! ${un} pre-existing — kept`);
        else { if (APPLY) await tx`DELETE FROM scm.mfg_products WHERE id = ${p.id}`; note(`  delete ${un}`); del++; }
      }
      const sides = [`${b}(LHF)`, `${b}(RHF)`];
      for (const c of sides) {
        poolNeed.add(c);
        const code = `${m}-${c}`;
        const [ex] = await tx`SELECT id FROM scm.mfg_products WHERE company_id = ${cid} AND code = ${code}`;
        if (ex) { skip++; continue; }
        const name = `SOFA ${mr.name} ${c}`.toUpperCase();
        if (APPLY) await tx`INSERT INTO scm.mfg_products
          (id, code, name, category, status, branding, base_model, model_id, company_id, created_at, updated_at)
          VALUES (${"mfg-" + randomBytes(6).toString("hex")}, ${code}, ${name}, 'SOFA', 'ACTIVE', 'ZANOTTI', ${m}, ${mr.id}, ${cid}, ${now}, ${now})`;
        note(`  mint ${code}`);
        mint++;
      }
      const ao = { ...(mr.allowed_options || {}) };
      ao.compartments = [...new Set([...(ao.compartments || []).filter((c) => c !== b), ...sides])];
      mr.allowed_options = ao;
      if (APPLY) await tx`UPDATE scm.product_models SET allowed_options = ${tx.json(ao)}, updated_at = ${now} WHERE id = ${mr.id}`;
      }
    }
    const [cfg] = await tx`SELECT id, config FROM scm.maintenance_config_history
      WHERE company_id = ${cid} AND scope = 'master' AND effective_from <= CURRENT_DATE
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
    const pool = new Set((cfg?.config?.sofaCompartments || []).map((v) => (typeof v === "object" ? v.value : v)));
    const add = [...poolNeed].filter((c) => !pool.has(c));
    if (add.length) {
      note(`pool additions: ${add.join(", ")}`);
      if (APPLY) {
        const next = { ...cfg.config, sofaCompartments: [...cfg.config.sofaCompartments.filter((v) => (typeof v === "object" ? v.value : v) !== "1B"), ...add] };
        await tx`INSERT INTO scm.maintenance_config_history (id, scope, config, effective_from, notes, created_at, company_id)
                 VALUES (${"mch-" + randomBytes(6).toString("hex")}, 'master', ${tx.json(next)}, CURRENT_DATE,
                         ${"bench sides 2026-08-10: 1B -> 1B(LHF)/1B(RHF)"}, ${now}, ${cid})`;
      }
    }
    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}): deleted=${del} minted=${mint} skip_exists=${skip}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN complete: rolled back."); });
}
main().then(() => sql.end({ timeout: 5 })).catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
