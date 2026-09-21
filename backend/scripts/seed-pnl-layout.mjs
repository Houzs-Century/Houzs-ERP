#!/usr/bin/env node
// seed-pnl-layout — write the owner's P&L tree into the report layout store
// (scm.acc_report_layouts, reports 'pnl' and 'performance'): the chart's own
// tree for income, cost of sales and taxation, and the Cash Flow tree's
// expense groups over the EXPENSES section, built by scripts/lib/pnl-tree.mjs
// (2026-09-19: pnl 那边的 account 显示要和 cash flow 一样 — 分父子 account). One
// tree for both companies; the Layout editor is where he adjusts it after.
//
// MODE=plan (default) reads the chart, builds each report's tree, validates
// it with the app's own validator, prints the outline block by block and the
// expense → group table, and prints the tree stored today in full — the
// backup, in the run's log — writing nothing. MODE=apply with CONFIRM='seed
// the P&L layouts from the cash flow tree' upserts the rows and re-reads
// them on a fresh connection. REPORTS=pnl (or performance) seeds one alone.
//
// RE-RUN: a second run REPLACES whatever a row holds, including every change
// made in the Layout editor since the first run — so it is run once, and
// only again after the plan output has been read against the stored tree it
// prints. Reset to chart in the editor is the way back to the default; the
// previous tree is in this script's plan log.
//
// Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)   REPORTS=pnl,performance
import postgres from 'postgres';
import { buildPnlExpenseTree, topIdsOf, withExpenseTree } from './lib/pnl-tree.mjs';
import { countLeaves, outline } from './lib/cash-flow-tree.mjs';
import { REPORT_BLOCKS, defaultLayout, validateLayout } from '../src/acc/report-layout.ts';
import { defaultSectionFor } from '../src/scm/lib/account-sections.ts';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'seed the P&L layouts from the cash flow tree';
const WHO = 'Claude — seeded from the Cash Flow tree (2026-09-21: Administrative expense)';
const ALLOWED = ['pnl', 'performance'];
const REPORTS = (process.env.REPORTS ?? 'pnl,performance').split(',').map((s) => s.trim()).filter(Boolean);

const log = (s) => console.log(s);
if (!['plan', 'apply'].includes(MODE)) {
  console.error(`MODE must be plan or apply (got ${JSON.stringify(MODE)}).`);
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}
if (REPORTS.length === 0 || REPORTS.some((r) => !ALLOWED.includes(r))) {
  console.error(`REPORTS must name pnl and/or performance (got ${JSON.stringify(process.env.REPORTS)}).`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set. Aborting.');
  process.exit(1);
}

const sectionOf = (a) => a.section ?? defaultSectionFor(a.type, a.code);

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
try {
  /* One definition per code across the companies — the lowest company id
     wins, as the chart page's own union reads it. */
  const chart = await sql`
    SELECT DISTINCT ON (account_code)
           account_code AS code, account_name AS name, account_type AS type, parent_code AS "parentCode", section
      FROM scm.accounts
     ORDER BY account_code, company_id`;
  const expenses = chart.filter((a) => sectionOf(a) === 'EXPENSES');
  const built = buildPnlExpenseTree(expenses);
  const planned = {};
  for (const report of REPORTS) {
    const layout = withExpenseTree(defaultLayout(report, chart), built.items);
    const checked = validateLayout(report, layout);
    if (!checked.ok) {
      console.error(`The ${report} tree does not validate: ${checked.reason}`);
      process.exit(1);
    }
    planned[report] = checked.layout;
  }

  log(`MODE=${MODE}  chart ${chart.length} account(s), ${expenses.length} under EXPENSES → ${countLeaves(built.items)} line(s) on the expense tree; reports: ${REPORTS.join(', ')}`);
  for (const report of REPORTS) {
    log(`\n=== THE ${report.toUpperCase()} TREE ===`);
    for (const block of REPORT_BLOCKS[report]) {
      const items = planned[report].blocks[block.key] ?? [];
      log(`  [${block.key}] ${block.title} · ${countLeaves(items)} line(s)${block.key === 'expenses' ? ' — the Cash Flow groups' : " — the chart's own"}`);
      for (const line of outline(items)) log(`    ${line}`);
    }
  }
  log('\n=== EXPENSE → GROUP ===');
  for (const m of built.mapping) log(`  ${m.code.padEnd(10)} ${m.group.padEnd(26)} ${m.name}${m.unmatched ? '   (no rule — Office & admin)' : ''}`);
  log(`\n${built.unmatched.length} expense account(s) without a rule of their own: ${built.unmatched.join(', ') || 'none'}`);

  for (const report of REPORTS) {
    const [current] = await sql`SELECT tree, updated_at, updated_by FROM scm.acc_report_layouts WHERE report = ${report}`;
    if (current) {
      log(`\n=== ${report}: STORED TODAY (by ${current.updated_by ?? '—'} on ${String(current.updated_at)}) — the backup ===`);
      log(JSON.stringify(current.tree));
    } else {
      log(`\n${report}: no layout is stored today — the report draws the chart's own tree.`);
    }
  }

  if (!APPLY) {
    log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  for (const report of REPORTS) {
    await sql`
      INSERT INTO scm.acc_report_layouts (report, tree, updated_at, updated_by)
      VALUES (${report}, ${sql.json(planned[report])}, now(), ${WHO})
      ON CONFLICT (report) DO UPDATE SET tree = EXCLUDED.tree, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`;
    log(`\nAPPLIED: the ${report} layout row was written.`);
  }
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  let bad = 0;
  for (const report of REPORTS) {
    const [row] = await check`
      SELECT tree, updated_by, jsonb_typeof(tree) AS kind
        FROM scm.acc_report_layouts WHERE report = ${report}`;
    const again = row ? validateLayout(report, row.tree) : { ok: false, reason: 'no row' };
    const ok = {
      'the row exists and holds a JSON object': Boolean(row) && row.kind === 'object',
      'the stored tree validates for the report': again.ok,
      'the expense groups are the planned ones, in order': Boolean(row) && JSON.stringify(topIdsOf(row.tree?.blocks?.expenses)) === JSON.stringify(topIdsOf(planned[report].blocks.expenses)),
      'every planned line is stored, block by block': Boolean(row) && REPORT_BLOCKS[report].every((b) => countLeaves(row.tree?.blocks?.[b.key] ?? []) === countLeaves(planned[report].blocks[b.key] ?? [])),
      'updated_by names this seeding': Boolean(row) && row.updated_by === WHO,
    };
    log(`\n=== VERIFY ${report} (fresh connection) ===`);
    for (const [k, v] of Object.entries(ok)) {
      if (!v) bad += 1;
      log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
    }
  }
  await check.end();
  if (bad) { console.error('VERIFY FAILED.'); process.exit(1); }
  log('VERIFY OK — the P&L reads the Cash Flow groups; the Layout editor takes it from here.');
} catch (e) {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
}
