#!/usr/bin/env node
// check-bank-recon-hard-5.mjs — READ ONLY. What a customer payment's bank entry carries for
// the "same amount + same name" rule to read: party_name and notes on SOPAY entries.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  await sql.begin('read only', async (tx) => {
    for (const r of await tx`
      SELECT company_id, count(*)::int AS n, count(party_name)::int AS with_party,
             count(*) FILTER (WHERE notes ~ '[A-Za-z]{3,}.*[A-Za-z]{3,}.*[A-Za-z]{3,}.*[A-Za-z]{3,}')::int AS long_notes
        FROM scm.v_gl_entries WHERE source_type = 'SOPAY' AND account_code LIKE '310-%' AND entry_date >= '2026-06-01' GROUP BY 1 ORDER BY 1`) {
      console.log(`ROW|SOPAY bank legs|co${r.company_id}|${r.n}|with party_name ${r.with_party}|notes with 4+ words ${r.long_notes}`);
    }
    for (const r of await tx`
      SELECT company_id, notes FROM scm.v_gl_entries WHERE source_type = 'SOPAY' AND account_code LIKE '310-%' AND entry_date >= '2026-09-01'
       ORDER BY random() LIMIT 8`) console.log(`ROW|notes|co${r.company_id}|${r.notes}`);
  });
  console.log('Read-only: nothing was written.');
} finally { await sql.end(); }
