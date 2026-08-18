#!/usr/bin/env node
// Safe post-seed cleanup for the AutoCount->ERP Houzs Century align:
//   1. copy Hookka Industries (400-H004) from co2 into co1
//   2. fix mangled standalone names (name := full AutoCount description)
//   3. fill mattress thickness in the generated names
//   4. sofa remap (owner map): delete the wrong created 1S SKU+model, bind the
//      real existing model's 1S SKU to both Hookka suppliers (supplier_sku keeps
//      the AutoCount code)
//   5. delete the LEAVING (CUSTOMISE) junk model+SKU+binding
// Idempotent. MODE=dry-run (default) writes nothing; MODE=apply performs it.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const mode = (process.env.MODE || "dry-run").toLowerCase();
const apply = mode === "apply";
const d = JSON.parse(readFileSync(process.env.DATA_FILE || "scripts/data/align-safe-cleanup.json", "utf-8"));
const cid = String(d.company_id);
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s == null ? "" : String(s).trim().toUpperCase().replace(/\s+/g, " "));

async function main() {
  console.log(`MODE=${mode} company_id=${cid}`);

  // 1. copy supplier(s)
  const supMap = new Map((await sql`SELECT id, code FROM scm.suppliers WHERE company_id=${cid}`).map((r) => [String(r.code).trim(), r.id]));
  for (const s of d.suppliers) {
    if (supMap.has(s.code)) { console.log(`supplier ${s.code}: exists`); continue; }
    if (apply) {
      const r = await sql`INSERT INTO scm.suppliers ${sql({ ...s, company_id: cid })} RETURNING id`;
      supMap.set(s.code, r[0].id);
    }
    console.log(`supplier ${s.code}: ${apply ? "created" : "would create"}`);
  }

  // 2. name fixes + 3. thickness (both are UPDATE name by code)
  let nameFixed = 0;
  for (const f of [...d.name_fixes, ...d.mattress_thickness]) {
    if (apply) {
      const r = await sql`UPDATE scm.mfg_products SET name=${f.name}, updated_at=now() WHERE company_id=${cid} AND code=${f.code}`;
      nameFixed += r.count;
    } else nameFixed++;
  }
  console.log(`names updated: ${nameFixed} (${d.name_fixes.length} mangled + ${d.mattress_thickness.length} thickness)`);

  // 4. sofa remap
  let bind = 0, delSku = 0, delModel = 0, missingExisting = 0;
  const existingBind = new Set((await sql`SELECT item_code, supplier_id FROM scm.supplier_material_bindings WHERE company_id=${cid}`).map((b) => `${norm(b.item_code)}||${b.supplier_id}`));
  for (const s of d.sofa_remap) {
    const exists = await sql`SELECT 1 FROM scm.mfg_products WHERE company_id=${cid} AND code=${s.existing_sku} LIMIT 1`;
    if (!exists.length) { console.log(`  sofa ${s.my_sku}: existing ${s.existing_sku} NOT FOUND, skip`); missingExisting++; continue; }
    for (const supCode of s.suppliers) {
      const sid = supMap.get(supCode);
      if (!sid) { console.log(`  sofa ${s.my_sku}: supplier ${supCode} missing`); continue; }
      if (existingBind.has(`${norm(s.existing_sku)}||${sid}`)) continue;
      existingBind.add(`${norm(s.existing_sku)}||${sid}`);
      if (apply) await sql`INSERT INTO scm.supplier_material_bindings ${sql({
        supplier_id: sid, material_kind: "mfg_product", item_code: s.existing_sku,
        material_name: s.existing_sku, supplier_sku: s.autocount_code, is_main_supplier: false,
        company_id: cid })}`;
      bind++;
    }
    if (apply) {
      await sql`DELETE FROM scm.supplier_material_bindings WHERE company_id=${cid} AND item_code=${s.my_sku}`;
      delSku += (await sql`DELETE FROM scm.mfg_products WHERE company_id=${cid} AND code=${s.my_sku}`).count;
      delModel += (await sql`DELETE FROM scm.product_models WHERE company_id=${cid} AND model_code=${s.my_model} AND category='SOFA'`).count;
    }
  }
  console.log(`sofa remap: bindings +${bind}, my SKUs deleted ${apply ? delSku : d.sofa_remap.length}, my models deleted ${apply ? delModel : d.sofa_remap.length}, missing-existing ${missingExisting}`);

  // 5. LEAVING junk
  let leav = 0;
  for (const code of d.leaving_delete) {
    if (apply) {
      await sql`DELETE FROM scm.supplier_material_bindings WHERE company_id=${cid} AND item_code=${code}`;
      leav += (await sql`DELETE FROM scm.mfg_products WHERE company_id=${cid} AND code=${code}`).count;
    } else leav++;
  }
  if (apply) await sql`DELETE FROM scm.product_models WHERE company_id=${cid} AND category='BEDFRAME' AND model_code ILIKE 'LEAVING%'`;
  console.log(`LEAVING deleted: ${leav} SKU(s) + model`);
  console.log(apply ? "APPLIED." : "DRY-RUN: nothing written.");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
