#!/usr/bin/env node
// Revert sofa Model `allowed_options.compartments` entries that have NO backing
// `mfg_products` SKU. Owner 2026-09-10: 「compartment 不需要」 —
// `open-all-sofa-model-options.mjs` a moment before wrote every pool
// compartment onto every sofa Model without minting the `{model}-{comp}` SKUs
// that a picker actually needs, so the picker now offers pieces the save path
// will refuse. This corrective script re-runs the filter that
// `open-5526-model.mjs` (the precedent for opening compartments) enforces
// alongside SKU minting: a Model may only list compartments whose paired SKU
// exists.
//
// SCOPE. company_id = HOUZS, category = 'SOFA', active = true. Only the
// `compartments` key is touched; `sizes / leg_heights / specials / fabrics`
// (opened by the earlier apply) are left as-is.
//
// SKU KEY. `mfg_products.code = ${model_code}-${compartment}` — the same
// convention `open-5526-model.mjs:198-202` uses when minting. Case-insensitive
// compare (all codes upper-cased) since the pool stores compartments verbatim
// and `mfg_products.code` is upper-cased on write.
//
// MODE=dry-run (default) rolls the whole transaction back and prints the
// per-Model delta so the survivor list is reviewable. MODE=apply requires
// CONFIRM="I HAVE REVIEWED THE DRY-RUN".
//
// RE-RUN: convergent. A second apply run finds no unbacked compartments and
// writes zero.
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
const K = (s) => String(s ?? "").trim().toUpperCase();

async function main() {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = ${"HOUZS"}`;
  if (!co) throw new Error("company HOUZS not found");
  const cid = co.id;
  note(`MODE=${MODE} company=HOUZS(${cid}) scope=sofa key=compartments`);

  await sql.begin(async (tx) => {
    const now = new Date().toISOString();

    const models = await tx`SELECT id, model_code, name, allowed_options
      FROM scm.product_models
      WHERE company_id = ${cid} AND category = 'SOFA' AND active = true
      ORDER BY model_code`;

    const skus = await tx`SELECT UPPER(code) AS code FROM scm.mfg_products
      WHERE company_id = ${cid} AND category = 'SOFA'`;
    const skuSet = new Set(skus.map((r) => r.code));

    let modelsChanged = 0;
    let removedTotal = 0;
    for (const m of models) {
      const opts = { ...(m.allowed_options ?? {}) };
      const cur = Array.isArray(opts.compartments) ? opts.compartments : [];
      if (cur.length === 0) continue;
      const kept = cur.filter((c) => skuSet.has(`${K(m.model_code)}-${K(c)}`));
      const removed = cur.filter((c) => !kept.includes(c));
      if (removed.length === 0) continue;
      opts.compartments = kept;
      modelsChanged += 1;
      removedTotal += removed.length;
      note(`  ${m.model_code} "${m.name}"  compartments-${removed.length}  (removed: ${removed.slice(0, 8).join(", ")}${removed.length > 8 ? " …" : ""}  kept: ${kept.length})`);
      if (APPLY) {
        await tx`UPDATE scm.product_models
          SET allowed_options = ${tx.json(opts)}, updated_at = ${now}
          WHERE id = ${m.id}`;
      }
    }

    note("");
    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}): models_touched=${modelsChanged}/${models.length} compartments_removed=${removedTotal}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => {
    if (e.message !== "DRY-RUN-ROLLBACK") throw e;
    note(`DRY-RUN complete: transaction rolled back, nothing written. MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
  });

  /* FRESH-CONNECTION verification (release-discipline rule 3). */
  if (APPLY) {
    const verify = postgres(url, { ssl: "require", prepare: false, max: 1 });
    try {
      const [co2] = await verify`SELECT id FROM public.companies WHERE code = ${"HOUZS"}`;
      const cid2 = co2.id;
      const rows = await verify`SELECT model_code, allowed_options
        FROM scm.product_models
        WHERE company_id = ${cid2} AND category = 'SOFA' AND active = true`;
      const skus2 = await verify`SELECT UPPER(code) AS code FROM scm.mfg_products
        WHERE company_id = ${cid2} AND category = 'SOFA'`;
      const skuSet2 = new Set(skus2.map((r) => r.code));
      const bad = [];
      for (const r of rows) {
        const comps = r.allowed_options?.compartments ?? [];
        if (!Array.isArray(comps)) { bad.push(`${r.model_code}(not-array)`); continue; }
        const stray = comps.filter((c) => !skuSet2.has(`${K(r.model_code)}-${K(c)}`));
        if (stray.length > 0) bad.push(`${r.model_code}(${stray.slice(0, 4).join(",")}${stray.length > 4 ? " …" : ""})`);
      }
      if (bad.length) throw new Error(`fresh-connection shape check FAILED — ${bad.length} model(s) still list a compartment with no SKU: ${bad.slice(0, 5).join("; ")}${bad.length > 5 ? " …" : ""}`);
      note(`fresh-connection shape check: every sofa Model's compartments are all SKU-backed (${rows.length} models, ${skuSet2.size} SKUs).`);
    } finally {
      await verify.end({ timeout: 5 });
    }
  }
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
