#!/usr/bin/env node
// check-cash-flow-layout.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09 (Cash Flow 一行settlement一行deposit, like his Receipt & Payment
// workbook): the saved Cash Flow tree (acc_report_layouts, report 'rp') as an outline —
// each category's id, name, side, subtotal name, the accounts under it with their names
// (Houzs, company 1) — so each group's Settlement / Deposit default can be set on it.
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
  const accts = await tx`SELECT company_id, account_code, account_name FROM scm.accounts WHERE company_id IN (1, 2)`;
  const name = new Map();
  for (const a of accts) if (!name.has(a.account_code) || a.company_id === 1) name.set(a.account_code, a.account_name);
  const walk = (items, depth) => {
    for (const it of items ?? []) {
      const pad = '  '.repeat(depth);
      if (it.kind === 'subtotal') out(`${pad}── SUBTOTAL "${it.label}" [${it.id}]`);
      else if (it.kind === 'category') {
        out(`${pad}▸ ${it.label} [${it.id}]${it.flow ? ` ${it.flow.toUpperCase()}` : ''}${it.totalLabel ? ` total="${it.totalLabel}"` : ''}${it.hiddenFor?.length ? ` hiddenFor=${it.hiddenFor}` : ''}`);
        walk(it.children, depth + 1);
      } else out(`${pad}· ${it.code} ${name.get(it.code) ?? '(no account)'}${it.flow ? ` (${it.flow})` : ''}`);
    }
  };
  walk(row.tree?.blocks?.accounts, 0);
});
await sql.end();
