#!/usr/bin/env node
// READ-ONLY final SKU-alignment status between the ERP and AutoCount for the
// writeback. Answers: are all AutoCount stock items represented in the ERP, and
// what exactly are the ERP products with no AutoCount code (real gap vs sofa
// compartments that collapse to a parent that IS bound). No writes.
import postgres from "postgres";
const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
function h(t) { console.log(`\n===== ${t} =====`); }

async function main() {
  console.log(`SKU alignment final status  company_id=${cid}  (read-only)`);

  const [tot] = await sql`SELECT count(*)::int n FROM scm.mfg_products WHERE company_id=${cid}`;
  const [linked] = await sql`
    SELECT count(DISTINCT p.code)::int n FROM scm.mfg_products p
    JOIN scm.supplier_material_bindings b ON b.material_code=p.code AND b.company_id=p.company_id
      AND b.material_kind='mfg_product' AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku)<>''
    WHERE p.company_id=${cid}`;
  console.log(`total ERP products: ${tot.n}   linked to an AutoCount code: ${linked.n}   unlinked: ${tot.n - linked.n}`);

  h("distinct AutoCount codes bound (how many AC items are represented)");
  const [acbound] = await sql`
    SELECT count(DISTINCT btrim(supplier_sku))::int n FROM scm.supplier_material_bindings
    WHERE company_id=${cid} AND material_kind='mfg_product' AND supplier_sku IS NOT NULL AND btrim(supplier_sku)<>''`;
  console.log(`  distinct AutoCount codes referenced by bindings: ${acbound.n}`);

  h("UNLINKED products by category");
  const byCat = await sql`
    SELECT coalesce(category::text,'(null)') cat, count(*)::int n FROM scm.mfg_products p
    WHERE company_id=${cid}
      AND NOT EXISTS (SELECT 1 FROM scm.supplier_material_bindings b
        WHERE b.material_code=p.code AND b.company_id=p.company_id AND b.material_kind='mfg_product'
          AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku)<>'')
    GROUP BY 1 ORDER BY 2 DESC`;
  for (const r of byCat) console.log(`  ${r.cat.padEnd(12)} ${r.n}`);

  h("UNLINKED SOFA: does the parent prefix have a bound sibling? (collapse-ok vs orphan)");
  const sofa = await sql`
    WITH unl AS (
      SELECT p.code, split_part(p.code,'-',1) parent FROM scm.mfg_products p
      WHERE p.company_id=${cid} AND p.category::text='SOFA'
        AND NOT EXISTS (SELECT 1 FROM scm.supplier_material_bindings b
          WHERE b.material_code=p.code AND b.company_id=p.company_id AND b.material_kind='mfg_product'
            AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku)<>'')
    )
    SELECT parent,
      count(*)::int unlinked,
      EXISTS (SELECT 1 FROM scm.supplier_material_bindings b
        JOIN scm.mfg_products p2 ON p2.code=b.material_code AND p2.company_id=b.company_id
        WHERE b.company_id=${cid} AND b.material_kind='mfg_product'
          AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku)<>''
          AND split_part(p2.code,'-',1)=unl.parent
          AND btrim(b.supplier_sku) LIKE '%SOFA%') AS parent_has_ac
    FROM unl GROUP BY parent ORDER BY parent`;
  let collapseOk = 0, orphan = 0;
  for (const r of sofa) {
    (r.parent_has_ac ? (collapseOk += r.unlinked) : (orphan += r.unlinked));
    console.log(`  ${r.parent.padEnd(10)} unlinked=${r.unlinked}  parent_has_AC_sofa_code=${r.parent_has_ac}`);
  }
  console.log(`  -> SOFA unlinked that COLLAPSE to a bound parent: ${collapseOk}`);
  console.log(`  -> SOFA unlinked that are ORPHAN (no bound parent): ${orphan}`);

  h("NON-SOFA unlinked (potential real gap) sample");
  const nonsofa = await sql`
    SELECT p.code, p.name, p.category::text cat FROM scm.mfg_products p
    WHERE p.company_id=${cid} AND coalesce(p.category::text,'') <> 'SOFA'
      AND NOT EXISTS (SELECT 1 FROM scm.supplier_material_bindings b
        WHERE b.material_code=p.code AND b.company_id=p.company_id AND b.material_kind='mfg_product'
          AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku)<>'')
    ORDER BY p.category, p.code LIMIT 40`;
  console.log(`  non-sofa unlinked shown: ${nonsofa.length}`);
  for (const r of nonsofa) console.log(`    [${r.cat}] ${r.code}  ${r.name}`);

  console.log("\nDONE (read-only).");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
