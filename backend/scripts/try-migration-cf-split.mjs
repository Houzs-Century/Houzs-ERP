#!/usr/bin/env node
// try-migration-cf-split.mjs — DRY RUN, ROLLED BACK. Runs migration
// 20261109T1900_acc_cash_flow_split_defaults (owner 2026-11-09: each Cash Flow group's
// Settlement / Deposit parts as his workbook has them) against PRODUCTION inside one
// transaction, prints every category that carries a split afterwards, and ROLLS BACK —
// nothing stays, whatever the outcome. Env: DATABASE_URL.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Dry run only: it always rolls back.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, onnotice: () => {} });
const out = (s) => console.log(`ROW|${s}`);
const text = readFileSync(new URL('./data/try-20261109T1900.sql', import.meta.url), 'utf8');
class Rollback extends Error {}
const splits = (items, depth = 0, acc = []) => {
  for (const it of items ?? []) {
    if (it.kind !== 'category') continue;
    acc.push(`${'  '.repeat(depth)}${it.label} [${it.id}]${it.split ? ` → ${it.split.settlement} : ${it.split.deposit}` : ''}`);
    splits(it.children, depth + 1, acc);
  }
  return acc;
};
try {
  await sql.begin(async (tx) => {
    const [before] = await tx`SELECT tree, updated_at::text AS at, updated_by FROM scm.acc_report_layouts WHERE report = 'rp'`;
    out(`before: saved ${before?.at} by ${before?.updated_by}; categories with a split: ${splits(before?.tree?.blocks?.accounts).filter((l) => l.includes('→')).length}`);
    await tx.unsafe(text);
    const [after] = await tx`SELECT tree, updated_at::text AS at, updated_by FROM scm.acc_report_layouts WHERE report = 'rp'`;
    out(`after: saved ${after?.at} by ${after?.updated_by}`);
    for (const l of splits(after?.tree?.blocks?.accounts)) out(l);
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) out('ROLLED BACK — the migration applies cleanly; nothing was kept.');
  else { out(`MIGRATION FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
} finally { await sql.end(); }
