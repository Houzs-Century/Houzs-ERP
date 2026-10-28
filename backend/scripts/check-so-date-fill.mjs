#!/usr/bin/env node
// check-so-date-fill.mjs — READ-ONLY. How mfg_sales_orders.so_date is filled on
// fair-linked orders (Event Commission "by SO date" returned no order, 2026-10-20):
// its type, how many are NULL, and how it compares with created_at.
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1).
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const [t] = await sql`SELECT data_type FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders' AND column_name = 'so_date'`;
  console.log('so_date type:', t?.data_type);
  const r = await sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE so_date IS NULL)::int AS null_so_date,
           min(so_date)::text AS min_so_date, max(so_date)::text AS max_so_date,
           count(*) FILTER (WHERE so_date::date = (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date)::int AS same_day_as_created
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND project_id IS NOT NULL AND created_at >= '2026-09-01'`;
  console.log('fair-linked orders created since 2026-09-01:', r[0]);
  const s = await sql`
    SELECT doc_no, so_date::text AS so_date, created_at::text AS created_at FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND project_id IS NOT NULL AND created_at >= '2026-10-01' ORDER BY created_at LIMIT 5`;
  for (const x of s) console.log(' ', x.doc_no, 'so_date', x.so_date, 'created', x.created_at);
  const c = await sql`
    SELECT count(*)::int AS n FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND project_id IS NOT NULL AND so_date >= '2026-10-01' AND so_date <= '2026-10-20'`;
  console.log('so_date in 2026-10-01..20 (raw SQL):', c[0].n);
} finally { await sql.end(); }
