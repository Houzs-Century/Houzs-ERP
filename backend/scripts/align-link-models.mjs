#!/usr/bin/env node
// Fixes the model-less bedframe/mattress/sofa SKUs the seed created: builds the
// missing product_models and links each SKU to its model (model_id + size_code
// + size_label + base_model + pos_active + allowed_options), so they behave like
// normally-opened SKUs and appear in the Modular view. Idempotent -- reuses an
// existing model (same model_code+category) instead of duplicating, and only
// updates SKUs whose model_id is still null. MODE=dry-run (default) writes
// nothing; MODE=apply performs the inserts/updates.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const mode = (process.env.MODE || "dry-run").toLowerCase();
const apply = mode === "apply";
const dataFile = process.env.DATA_FILE || "scripts/data/align-models-houzs-century.json";
const data = JSON.parse(readFileSync(dataFile, "utf-8"));
const cid = String(data.company_id);
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

async function main() {
  console.log(`MODE=${mode} company_id=${cid} models=${data.models.length} skus=${data.skus.length}`);

  // Phase 1: models -> id (reuse existing model_code+category, else create)
  const idByIndex = new Map();
  let created = 0, reused = 0;
  for (const m of data.models) {
    const existing = await sql`SELECT id FROM scm.product_models WHERE company_id=${cid} AND model_code=${m.model_code} AND category=${m.category} LIMIT 1`;
    if (existing.length) { idByIndex.set(m.i, existing[0].id); reused++; continue; }
    if (apply) {
      const r = await sql`INSERT INTO scm.product_models (branding, model_code, name, category, allowed_options, active, company_id)
        VALUES (${m.branding || null}, ${m.model_code}, ${m.name}, ${m.category}, ${sql.json(m.allowed_options)}, true, ${cid})
        RETURNING id`;
      idByIndex.set(m.i, r[0].id);
    } else {
      idByIndex.set(m.i, `<new-${m.i}>`);
    }
    created++;
  }
  console.log(`models: create ${created}, reuse-existing ${reused}`);

  // Phase 2: link each SKU to its model
  let linked = 0, missing = 0;
  for (const s of data.skus) {
    const mid = idByIndex.get(s.model_i);
    if (apply) {
      const r = await sql`UPDATE scm.mfg_products
        SET model_id=${mid}, size_code=${s.size_code || null}, size_label=${s.size_label || null},
            base_model=${s.base_model || null}, pos_active=true, updated_at=now()
        WHERE company_id=${cid} AND code=${s.code} AND model_id IS NULL`;
      if (r.count) linked += r.count; else missing++;
    } else {
      linked++;
    }
  }
  console.log(`skus: linked ${linked}${missing ? `, already-linked/absent ${missing}` : ""}`);
  console.log(apply ? "APPLIED." : "DRY-RUN: nothing written.");
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
