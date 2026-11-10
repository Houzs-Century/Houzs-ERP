#!/usr/bin/env node
// check-so-balance.mjs — READ ONLY. An order's money fields (total, paid, balance) as stored,
// to tell whether a stray bank credit could be its next instalment.
// Env: DATABASE_URL, SO (default 2990-SO-2609-042).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only'); process.exit(1); }
const SO = String(process.env.SO || '2990-SO-2609-042');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  await sql.begin('read only', async (tx) => {
    for (const o of await tx`SELECT to_jsonb(o) AS j FROM scm.mfg_sales_orders o WHERE o.doc_no = ${SO}`) {
      const pick = Object.entries(o.j).filter(([k]) => /total|paid|balance|amount|status|debtor|phone|deposit/i.test(k));
      console.log(`ROW|ORDER|${SO}|${pick.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ; ')}`);
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
