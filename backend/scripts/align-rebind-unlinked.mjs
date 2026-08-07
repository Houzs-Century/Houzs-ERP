#!/usr/bin/env node
// Bind ERP mfg_products that have an existing AutoCount stock item but no
// supplier_material_binding yet, by COPYING an existing "sibling" binding that
// already carries that AutoCount code (supplier_sku). Pure additive: inserts
// only for products with zero current binding; never edits or deletes.
//
// Pairs come from backend/scripts/data/autocount-sku-rebind-pairs.tsv
// (erp_code \t ac_code \t jaccard \t DUP|NEEDSBIND \t category), produced by a
// name-based match against a read-only dump of the AutoCount Item master.
//
// MODE=dry-run (default) reports; MODE=apply writes. company_id=1 (Houzs Century).
import postgres from "postgres";
import fs from "fs";
const mode = (process.env.MODE || "dry-run").toLowerCase();
const apply = mode === "apply";
const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

const pairs = fs.readFileSync(new URL("./data/autocount-sku-rebind-pairs.tsv", import.meta.url), "utf8")
  .split(/\r?\n/).filter(Boolean).map(l => { const [erp, ac, jac, cls, cat] = l.split("\t"); return { erp, ac, jac, cls, cat }; });

async function main() {
  console.log(`MODE=${mode} company_id=${cid}  pairs=${pairs.length}`);

  // Schema sanity (printed once so the insert shape is auditable).
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='scm' AND table_name='supplier_material_bindings' ORDER BY ordinal_position`;
  console.log(`binding columns: ${cols.map(c => c.column_name).join(", ")}`);

  let inserted = 0, alreadyBound = 0, noSibling = 0, missingProduct = 0;
  const noSibList = [];
  for (const p of pairs) {
    const [prod] = await sql`SELECT 1 FROM scm.mfg_products WHERE company_id=${cid} AND code=${p.erp} LIMIT 1`;
    if (!prod) { missingProduct++; continue; }
    const [existing] = await sql`
      SELECT 1 FROM scm.supplier_material_bindings
      WHERE company_id=${cid} AND material_kind='mfg_product' AND material_code=${p.erp}
        AND supplier_sku IS NOT NULL AND btrim(supplier_sku)<>'' LIMIT 1`;
    if (existing) { alreadyBound++; continue; }
    const [sib] = await sql`
      SELECT supplier_id, supplier_sku, is_main_supplier FROM scm.supplier_material_bindings
      WHERE company_id=${cid} AND material_kind='mfg_product' AND btrim(supplier_sku)=${p.ac}
      ORDER BY is_main_supplier DESC LIMIT 1`;
    if (!sib) { noSibling++; noSibList.push(`${p.erp} -> ${p.ac} (${p.cls})`); continue; }
    if (apply) {
      const res = await sql`
        INSERT INTO scm.supplier_material_bindings (company_id, material_kind, material_code, supplier_id, supplier_sku, is_main_supplier)
        VALUES (${cid}, 'mfg_product', ${p.erp}, ${sib.supplier_id}, ${sib.supplier_sku}, false)`;
      inserted += res.count;
    } else inserted++;
  }
  console.log(`\n${apply ? "INSERTED" : "would insert"}: ${inserted}`);
  console.log(`skip already-bound:     ${alreadyBound}`);
  console.log(`skip no-sibling:        ${noSibling}`);
  console.log(`skip product-not-found: ${missingProduct}`);
  if (noSibList.length) { console.log(`\n--- no-sibling (need supplier resolved separately) ---`); noSibList.forEach(x => console.log("  " + x)); }
  console.log(apply ? "\nAPPLIED." : "\nDRY-RUN: nothing written.");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
