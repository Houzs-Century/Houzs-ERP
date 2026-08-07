import postgres from "postgres";
const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
// 1) supplier table shape + how creditor code maps to supplier_id
const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name='suppliers' ORDER BY ordinal_position`;
console.log("suppliers cols:", cols.map(c=>c.column_name).join(", "));
const sup = await sql`SELECT * FROM scm.suppliers WHERE company_id=${cid} LIMIT 3`;
console.log("sample supplier row:", JSON.stringify(sup[0]||{}).slice(0,400));
// 2) do surviving bindings exist for the sofa parent codes we deleted?
const codes = ['HOK-5535 SOFA','DSL-8060 SOFA','DSL-9028 SOFA','AMN-SF9015 SOFA','HOK-5530 SOFA'];
for (const c of codes) {
  const r = await sql`SELECT count(*)::int n FROM scm.supplier_material_bindings WHERE company_id=${cid} AND material_kind='mfg_product' AND btrim(supplier_sku)=${c}`;
  console.log(`surviving bindings to ${c}: ${r[0].n}`);
}
// 3) creditor codes -> can we map to scm.suppliers? show suppliers whose code/name hints AMN/DSL/HOK/TD
const hint = await sql`SELECT id, code, name FROM scm.suppliers WHERE company_id=${cid} AND (code ILIKE '%400-%' OR code IN ('400-A004','400-D004','400-O002','400-T004','400-T005') OR name ILIKE '%hookka%' OR name ILIKE '%diensl%') LIMIT 20`;
console.log("supplier hints:"); for (const h of hint) console.log(`  ${h.id} | ${h.code} | ${h.name}`);
await sql.end();
