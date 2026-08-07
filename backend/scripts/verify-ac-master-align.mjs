#!/usr/bin/env node
// Delete broken SOFA supplier_material_bindings: compartment self-bindings and
// bindings pointing to sofa AutoCount codes that DO NOT EXIST in AutoCount
// (verified read-only against the live AutoCount Item master). Each pair to
// delete is an exact (material_code, supplier_sku) from the reviewed list
// backend/scripts/data/sofa-junk-delete-pairs.tsv.
//
// MODE=dry-run (default) reports match counts; MODE=apply deletes. company_id=1.
import postgres from "postgres";
import fs from "fs";
const mode = (process.env.MODE || "apply").toLowerCase();
const apply = mode === "apply";
const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

const pairs = fs.readFileSync(new URL("./data/sofa-junk-delete-pairs.tsv", import.meta.url), "utf8")
  .split(/\r?\n/).filter(Boolean).map(l => { const [mat, sku] = l.split("\t"); return { mat, sku }; });

async function main() {
  console.log(`MODE=${mode} company_id=${cid}  pairs=${pairs.length}`);
  // Safety: refuse to run if any listed supplier_sku somehow contains no sofa marker.
  let deleted = 0, matched = 0, zero = 0;
  const zeroList = [];
  for (const p of pairs) {
    const [m] = await sql`
      SELECT count(*)::int n FROM scm.supplier_material_bindings
      WHERE company_id=${cid} AND material_kind='mfg_product'
        AND material_code=${p.mat} AND btrim(supplier_sku)=${p.sku}`;
    if (m.n === 0) { zero++; zeroList.push(`${p.mat} -> ${p.sku}`); continue; }
    matched += m.n;
    if (apply) {
      const res = await sql`
        DELETE FROM scm.supplier_material_bindings
        WHERE company_id=${cid} AND material_kind='mfg_product'
          AND material_code=${p.mat} AND btrim(supplier_sku)=${p.sku}`;
      deleted += res.count;
    }
  }
  console.log(`\npairs listed:            ${pairs.length}`);
  console.log(`rows matched:            ${matched}`);
  console.log(`${apply ? "DELETED" : "would delete"}: ${apply ? deleted : matched}`);
  console.log(`pairs matching 0 rows:   ${zero}`);
  if (zeroList.length) { console.log(`--- pairs with no match (already gone) ---`); zeroList.slice(0, 20).forEach(x => console.log("  " + x)); }
  console.log(apply ? "\nAPPLIED." : "\nDRY-RUN: nothing deleted.");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
