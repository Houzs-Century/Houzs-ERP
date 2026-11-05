#!/usr/bin/env node
// check-debtor-codes-live.mjs: READ ONLY. The other debtors' account codes on production.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), prepare: false, max: 1 });
await sql.begin('READ ONLY', async (tx) => {
  for (const r of await tx`SELECT company_id, code, name FROM scm.acc_debtors ORDER BY company_id, code NULLS LAST, name`) console.log(`ROW|${r.company_id} ${r.code ?? '(none)'} ${r.name}`);
  const [i] = await tx`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'scm' AND indexname = 'acc_debtors_company_code_key'`;
  console.log(`ROW|unique index present: ${i.n}`);
  const lines = await tx`SELECT count(*)::int AS n FROM scm.journal_entry_lines WHERE party_type = 'ODEBTOR' AND party_code IS NOT NULL`;
  console.log(`ROW|other-debtor journal lines carrying a party code: ${lines[0].n}`);
});
await sql.end();
