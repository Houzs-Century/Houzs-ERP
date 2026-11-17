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
  const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'products'`).map((r) => r.column_name);
  console.log('products columns: ' + cols.join(', '));
  const name = cols.includes('name') ? 'name' : cols.includes('description') ? 'description' : 'code';
  const rows = await sql`
    SELECT p.company_id, p.code, p.${sql(name)} AS name,
           (SELECT count(*) FROM scm.mfg_sales_order_items i WHERE i.item_code = p.code)::int AS so_lines
      FROM scm.products p
     WHERE p.code ~* ${MATCH} OR p.${sql(name)} ~* ${MATCH}
     ORDER BY p.company_id, p.code`;
  for (const r of rows) console.log(`${r.company_id} | ${r.code} | ${r.name} | so lines ${r.so_lines}`);
  console.log(`codes: ${rows.length}`);
} finally {
  await sql.end();
}
