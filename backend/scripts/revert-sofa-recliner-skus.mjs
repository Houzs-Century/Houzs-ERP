#!/usr/bin/env node
// Revert opener round 2's recliner/power SKUs on the models the owner ruled
// CANNOT recline (2026-08-10: "8030 8060 9058 9028 / 9050 8069 5535 都不会有
// 电动 power 或者 recliner"). Deletes ONLY the 28 SKUs that round minted
// (created 2026-08-10, never referenced by any SO line) and strips the codes
// from allowed_options.compartments. Gated: dry-run default, apply needs the
// confirm phrase. 8038/8051 keep theirs (power pairs pre-existed).
import postgres from "postgres";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const APPLY = MODE === "apply" && process.env.CONFIRM === "I HAVE REVIEWED THE DRY-RUN";
if (MODE === "apply" && !APPLY) { console.error("apply needs CONFIRM"); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const MODELS = ["8030", "8060", "9058", "9028", "9050", "8069", "5535"];
const COMPS = ["1A(R)(LHF)", "1A(R)(RHF)", "1A(P)(LHF)", "1A(P)(RHF)"];

async function main() {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = ${"HOUZS"}`;
  const cid = co.id;
  await sql.begin(async (tx) => {
    let deleted = 0, kept = 0, opts = 0;
    for (const m of MODELS) {
      for (const c of COMPS) {
        const code = `${m}-${c}`;
        const [p] = await tx`SELECT id, created_at FROM scm.mfg_products
          WHERE company_id = ${cid} AND code = ${code}`;
        if (!p) { kept++; continue; }
        if (new Date(p.created_at) < new Date("2026-08-09T20:00:00Z")) {
          note(`  !! ${code} pre-dates round 2 — NOT deleting`); kept++; continue;
        }
        const [ref] = await tx`SELECT 1 AS x FROM scm.mfg_sales_order_items WHERE item_code = ${code} LIMIT 1`;
        if (ref) { note(`  !! ${code} referenced by an SO line — NOT deleting`); kept++; continue; }
        if (APPLY) await tx`DELETE FROM scm.mfg_products WHERE id = ${p.id}`;
        note(`  delete ${code}`);
        deleted++;
      }
      const [mr] = await tx`SELECT id, allowed_options FROM scm.product_models
        WHERE company_id = ${cid} AND model_code = ${m} AND category = 'SOFA'`;
      if (mr) {
        const ao = { ...(mr.allowed_options || {}) };
        const before = (ao.compartments || []).length;
        ao.compartments = (ao.compartments || []).filter((c) => !COMPS.includes(c));
        if (ao.compartments.length !== before) {
          if (APPLY) await tx`UPDATE scm.product_models SET allowed_options = ${tx.json(ao)}, updated_at = ${new Date().toISOString()} WHERE id = ${mr.id}`;
          opts++;
        }
      }
    }
    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}): deleted=${deleted} kept=${kept} model_opts_cleaned=${opts}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN complete: rolled back."); });
}
main().then(() => sql.end({ timeout: 5 })).catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
