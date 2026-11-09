#!/usr/bin/env node
// check-cash-flow-splits.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// After #5445 (migration 20261109T1900_acc_cash_flow_split_defaults): the saved Cash Flow
// tree's categories that carry a Settlement / Deposit split, and whether the migration
// is recorded as applied.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);

await sql.begin('READ ONLY', async (tx) => {
  const [row] = await tx`SELECT tree, updated_at::text AS at, updated_by FROM scm.acc_report_layouts WHERE report = 'rp'`;
  if (!row) { out('no saved Cash Flow layout'); return; }
  out(`saved ${row.at} by ${row.updated_by}`);
  const walk = (items, depth) => {
    for (const it of items ?? []) {
      if (it.kind !== 'category') continue;
      out(`${'  '.repeat(depth)}${it.label} [${it.id}] ${it.split ? `split ${it.split.settlement}:${it.split.deposit}` : '—'}`);
      walk(it.children, depth + 1);
    }
  };
  walk(row.tree?.blocks?.accounts, 0);
  const tables = await tx`SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_name ILIKE '%migration%' ORDER BY 1`;
  out(`migration tables: ${tables.map((t) => t.t).join(', ')}`);
});
await sql.end();
