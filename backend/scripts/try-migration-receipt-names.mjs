#!/usr/bin/env node
// try-migration-receipt-names.mjs — DRY RUN, ROLLED BACK. Runs migration
// 20261109T2200_acc_receipt_customer_names (owner 2026-11-09: receipts print no customer
// name; the catch-up's confirmer becomes Chew) against PRODUCTION inside one transaction,
// prints the counts before and after and a few receipts, and ROLLS BACK — nothing stays,
// whatever the outcome. Env: DATABASE_URL.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Dry run only: it always rolls back.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, onnotice: () => {} });
const out = (s) => console.log(`ROW|${s}`);
const text = readFileSync(new URL('./data/try-20261109T2200.sql', import.meta.url), 'utf8');
class Rollback extends Error {}
const counts = async (tx, when) => {
  for (const r of await tx`
    SELECT company_id, count(*)::int AS n,
           count(*) FILTER (WHERE COALESCE(btrim(customer_name), '') = '')::int AS nameless,
           count(*) FILTER (WHERE issued_by LIKE 'Claude, for the owner%')::int AS claude,
           count(*) FILTER (WHERE issued_by = 'Chew')::int AS chew
      FROM scm.acc_official_receipts GROUP BY 1 ORDER BY 1`) {
    out(`${when} co${r.company_id}: ${r.n} receipts · nameless ${r.nameless} · confirmer "Claude…" ${r.claude} · confirmer Chew ${r.chew}`);
  }
};
try {
  await sql.begin(async (tx) => {
    await counts(tx, 'before');
    await tx.unsafe(text);
    await counts(tx, 'after ');
    for (const r of await tx`SELECT or_number, status, doc_no, customer_name, issued_by FROM scm.acc_official_receipts
                              WHERE or_number IN ('2990-HOR-2611-021', 'HC-MOR-2609-255') OR COALESCE(btrim(customer_name), '') = '' ORDER BY or_number LIMIT 12`) {
      out(`${r.or_number} ${r.status} ${r.doc_no ?? '∅'} name=${r.customer_name ?? '∅'} confirmer=${r.issued_by ?? '∅'}`);
    }
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) out('ROLLED BACK — the migration applies cleanly; nothing was kept.');
  else { out(`MIGRATION FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
} finally { await sql.end(); }
