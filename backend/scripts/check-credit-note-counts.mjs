#!/usr/bin/env node
// check-credit-note-counts.mjs — READ ONLY. The credit / debit notes on file by
// company, kind and status (owner 2026-10-28: the two CN / DN pages — does
// Money in's "All" show every customer and other-debtor note?). Env: DATABASE_URL.
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const rows = await sql`SELECT company_id, kind, status, count(*)::int AS n, sum(total_sen)::bigint AS sen
    FROM scm.acc_credit_notes GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
  for (const r of rows) console.log(`ROW|company ${r.company_id} ${r.kind} ${r.status}: ${r.n} (RM ${(Number(r.sen) / 100).toFixed(2)})`);
} finally {
  await sql.end();
}
