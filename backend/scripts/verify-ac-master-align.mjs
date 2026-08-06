import postgres from "postgres";
const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const rows = await sql`
  SELECT b.material_code, btrim(b.supplier_sku) sku FROM scm.supplier_material_bindings b
  WHERE b.company_id=${cid} AND b.material_kind='mfg_product'
    AND b.supplier_sku IS NOT NULL AND btrim(b.supplier_sku)<>''
  ORDER BY 1`;
console.log(`BIND_COUNT ${rows.length}`);
for (const r of rows) console.log(`BIND\t${r.material_code}\t${r.sku}`);
await sql.end();
