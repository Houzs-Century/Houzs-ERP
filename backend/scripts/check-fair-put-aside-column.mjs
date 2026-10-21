#!/usr/bin/env node
// check-fair-put-aside-column.mjs — READ-ONLY. After #4845 deploys: the two
// Fair Links put-aside columns exist on scm.mfg_sales_orders, the migration is
// recorded, and how many orders are put aside so far.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const cols = await sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders'
       AND column_name IN ('fair_put_aside_at', 'fair_put_aside_by')
     ORDER BY column_name`;
  for (const c of cols) console.log(`column ${c.column_name} ${c.data_type} nullable=${c.is_nullable}`);
  if (cols.length !== 2) console.log(`MISSING: found ${cols.length} of 2 columns`);
  const tables = await sql`SELECT to_regclass('public.schema_migrations') AS a, to_regclass('scm.schema_migrations') AS b`;
  console.log(`schema_migrations: ${tables[0].a ?? '-'} / ${tables[0].b ?? '-'}`);
  if (cols.length === 2) {
    const n = await sql`SELECT company_id, count(*)::int AS n FROM scm.mfg_sales_orders WHERE fair_put_aside_at IS NOT NULL GROUP BY 1 ORDER BY 1`;
    console.log(`put aside so far: ${n.length ? n.map((r) => `co${r.company_id}=${r.n}`).join(', ') : 'none'}`);
  }
} finally { await sql.end(); }
