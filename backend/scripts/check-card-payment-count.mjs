#!/usr/bin/env node
// check-card-payment-count.mjs — READ-ONLY. How many card payments "Find the
// sale" reads per company once it pages instead of stopping at PostgREST's
// 1000 rows: card / instalment / imported, settled or not, by year.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const so = await sql`SELECT company_id, method, to_char(paid_at, 'YYYY') AS y, count(*)::int AS n FROM scm.mfg_sales_order_payments WHERE method IN ('merchant','installment','imported') GROUP BY 1,2,3 ORDER BY 1,2,3`;
  for (const r of so) console.log(`SO co ${r.company_id} ${r.method} ${r.y}: ${r.n}`);
  const si = await sql`SELECT company_id, count(*)::int AS n FROM scm.sales_invoice_payments WHERE method IN ('merchant','installment','imported') GROUP BY 1`;
  for (const r of si) console.log(`SI co ${r.company_id}: ${r.n}`);
  const docs = await sql`SELECT company_id, count(DISTINCT so_doc_no)::int AS n FROM scm.mfg_sales_order_payments WHERE method IN ('merchant','installment','imported') GROUP BY 1`;
  for (const r of docs) console.log(`distinct orders co ${r.company_id}: ${r.n}`);
} finally { await sql.end(); }
