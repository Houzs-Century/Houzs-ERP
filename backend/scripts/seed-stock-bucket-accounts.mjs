#!/usr/bin/env node
// seed-stock-bucket-accounts — open the nine child accounts the three closing
// stocks book on, in every company whose chart carries the parents (owner
// 2026-09-21: closing stock - customer / display / service; chart of account
// 那边也需要分出来; 父户不记账 — the close posts to these children, never to
// 330-0000 / 600-0000 / 620-0000 again). Rows built by scripts/lib/
// stock-bucket-accounts.mjs: -0001 customer, -0002 display, -0003 service,
// the parent's type, section and special marker, is_active, no money flag.
//
// MODE=plan (default) reads every company's chart and prints, per company,
// the children it lacks, the ones it already has (and whether they sit under
// the right parent) and any parent it lacks — writing nothing. MODE=apply
// with CONFIRM='seed the closing stock bucket accounts' INSERTS the missing
// rows only, then re-reads every company on a fresh connection and checks
// the shape: the nine exist, active, each under its parent.
//
// RE-RUN: a second apply finds nothing missing and inserts nothing — rows
// already on the chart are never updated (a renamed child keeps its name).
//
// Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
import postgres from 'postgres';
import { planFor, stockBucketAccounts } from './lib/stock-bucket-accounts.mjs';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'seed the closing stock bucket accounts';

const log = (s) => console.log(s);
if (!['plan', 'apply'].includes(MODE)) {
  console.error(`MODE must be plan or apply (got ${JSON.stringify(MODE)}).`);
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set. Aborting.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
try {
  const companies = await sql`SELECT id, code, name FROM public.companies ORDER BY id`;
  const plans = [];
  for (const co of companies) {
    const chart = await sql`
      SELECT account_code AS code, parent_code AS "parentCode", is_active AS active
        FROM scm.accounts WHERE company_id = ${co.id}`;
    const plan = planFor(chart);
    plans.push({ co, plan });
    log(`\n=== ${co.code} (company ${co.id}) — ${chart.length} account(s) ===`);
    if (plan.parentsMissing.length) log(`  parents missing, nothing planned under them: ${plan.parentsMissing.join(', ')}`);
    for (const a of plan.present) log(`  have    ${a.code}  ${a.name}${a.active ? '' : '  (INACTIVE)'}${a.parentOk ? '' : `  (parent is not ${a.parentCode})`}`);
    for (const a of plan.missing) log(`  create  ${a.code}  ${a.name}  · ${a.type} · ${a.section} · ${a.special} · under ${a.parentCode}`);
    if (!plan.missing.length && !plan.parentsMissing.length) log('  nothing to create.');
  }
  const total = plans.reduce((s, p) => s + p.plan.missing.length, 0);
  log(`\nMODE=${MODE}  ${total} row(s) to create across ${companies.length} company(ies).`);
  if (!APPLY) {
    log('PLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }
  for (const { co, plan } of plans) {
    for (const a of plan.missing) {
      await sql`
        INSERT INTO scm.accounts (company_id, account_code, account_name, account_type, parent_code, is_active, acc_money, special_type, section)
        VALUES (${co.id}, ${a.code}, ${a.name}, ${a.type}, ${a.parentCode}, true, false, ${a.special}, ${a.section})`;
      log(`APPLIED: ${co.code} ${a.code} ${a.name}`);
    }
  }
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  let bad = 0;
  const wanted = stockBucketAccounts();
  for (const { co, plan } of plans) {
    const rows = await check`
      SELECT account_code AS code, account_name AS name, account_type AS type, parent_code AS "parentCode", is_active AS active, section, special_type AS special
        FROM scm.accounts WHERE company_id = ${co.id} AND account_code = ANY(${wanted.map((a) => a.code)})`;
    const byCode = new Map(rows.map((r) => [r.code, r]));
    log(`\n=== VERIFY ${co.code} (fresh connection) ===`);
    for (const a of wanted) {
      if (plan.parentsMissing.includes(a.parentCode)) continue;
      const r = byCode.get(a.code);
      const ok = Boolean(r) && r.active === true && r.parentCode === a.parentCode && r.type === a.type;
      if (!ok) bad += 1;
      log(`  ${ok ? 'OK   ' : 'WRONG'} ${a.code} ${r ? `${r.name} · ${r.type} · under ${r.parentCode ?? '—'} · ${r.active ? 'active' : 'inactive'}` : 'missing'}`);
    }
  }
  await check.end();
  if (bad) { console.error('VERIFY FAILED.'); process.exit(1); }
  log('VERIFY OK — the closing stocks have their accounts; the next stock close books on them.');
} catch (e) {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
}
