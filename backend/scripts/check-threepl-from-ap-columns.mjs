#!/usr/bin/env node
// check-threepl-from-ap-columns.mjs — READ-ONLY. After PR #4921 deployed:
// migration 20261024T1000 left threepl_do_charges.ap_invoice_id,
// threepl_companies.supplier_id and the partial index on prod. Writes nothing.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const cols = await sql`SELECT table_name AS t, column_name AS c, data_type AS d FROM information_schema.columns
    WHERE table_schema = 'scm' AND ((table_name = 'threepl_do_charges' AND column_name = 'ap_invoice_id') OR (table_name = 'threepl_companies' AND column_name = 'supplier_id'))`;
  for (const r of cols) console.log(`ROW|column ${r.t}.${r.c} ${r.d}`);
  const idx = await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'scm' AND indexname = 'idx_threepl_do_charges_ap_invoice'`;
  console.log(`ROW|index ${idx.length ? idx[0].indexname : 'MISSING'}`);
  const n = await sql`SELECT count(*)::int AS n FROM scm.threepl_do_charges`;
  console.log(`ROW|3PL charge rows: ${n[0].n}`);
} finally { await sql.end(); }
