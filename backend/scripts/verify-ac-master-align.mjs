import postgres from "postgres";
const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const rows = await sql`
  SELECT p.code, p.name, p.category::text cat FROM scm.mfg_products p
  WHERE p.company_id=${cid} AND coalesce(p.category::text,'') <> 'SOFA'
    AND NOT EXISTS (SELECT 1 FROM scm.supplier_material_bindings b
      WHERE b.material_code=p.code AND b.company_id=p.company_id AND b.material_kind='mfg_product'
        AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku)<>'')
  ORDER BY p.category, p.code`;
console.log(`NONSOFA_UNLINKED_COUNT ${rows.length}`);
for (const r of rows) console.log(`ROW\t${r.code}\t${r.name}\t${r.cat}`);
await sql.end();
