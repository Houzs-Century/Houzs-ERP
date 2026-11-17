// Read-only: the catalogue codes whose code or name matches a model (MATCH, a
// regex), per company, with how many open sales-order lines use each. Codes and
// names only.
//
// RE-RUN: Actions -> "Run a backend script on production" -> check-model-codes.mjs,
//   mode plan. Env: MATCH=SOFFIO|8030. Writes nothing anywhere.
import postgres from 'postgres';

const MATCH = process.env.MATCH || 'SOFFIO|8030';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const icols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'mfg_sales_order_items'`).map((r) => r.column_name);
  console.log('so item columns: ' + icols.filter((c) => /code|name|desc|group|model/.test(c)).join(', '));
  const desc = ['description', 'item_description', 'item_name', 'material_name'].find((c) => icols.includes(c)) ?? 'item_code';
  const rows = await sql`
    SELECT i.item_code, min(i.${sql(desc)}) AS name, count(*)::int AS so_lines, max(o.so_date)::text AS last_so,
           count(DISTINCT o.company_id)::int AS companies
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
     WHERE i.item_code ~* ${MATCH} OR i.${sql(desc)} ~* ${MATCH}
     GROUP BY i.item_code ORDER BY i.item_code`;
  for (const r of rows) console.log(`${r.item_code} | ${r.name} | lines ${r.so_lines} | last ${String(r.last_so).slice(0, 10)}`);
  console.log(`codes: ${rows.length}`);
  const pcols = ['sku', 'model_code', 'name'];
  const prods = await sql`SELECT company_id, sku, model_code, name FROM scm.products WHERE sku ~* ${MATCH} OR model_code ~* ${MATCH} OR name ~* ${MATCH} ORDER BY sku`;
  for (const r of prods) console.log(`product ${r.company_id} | ${r.sku} | ${r.model_code} | ${r.name}`);
  void pcols;
} finally {
  await sql.end();
}
