#!/usr/bin/env node
// seed-cash-flow-layout — write the owner's Cash Flow tree into the report
// layout store (scm.acc_report_layouts, report 'rp'), built from the chart
// of accounts by scripts/lib/cash-flow-tree.mjs the way his two cash-flow
// workbooks read it (2026-09-18: 你先做，然后我才自己调). One tree for both
// companies; the Layout editor is where he adjusts it afterwards.
//
// MODE=plan (default) reads the chart, builds the tree, validates it with
// the app's own validator, prints the outline and the account → group table,
// and prints the tree stored today in full — the backup, in the run's log —
// writing nothing. MODE=apply with CONFIRM='seed the cash flow layout from
// the workbooks' upserts the row and re-reads it on a fresh connection.
//
// RE-RUN: a second run REPLACES whatever the row holds, including every
// change made in the Layout editor since the first run — so it is run once,
// and only again after the plan output has been read against the stored
// tree it prints. Reset to chart in the editor is the way back to the
// default; the previous tree is in this script's plan log.
//
// Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
import postgres from 'postgres';
import { buildCashFlowTree, countLeaves, outline, topIds } from './lib/cash-flow-tree.mjs';
import { validateLayout } from '../src/acc/report-layout.ts';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'seed the cash flow layout from the workbooks';
const WHO = 'Claude — seeded from the cash-flow workbooks (2026-09-18)';

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
  const accounts = await sql`
    SELECT account_code AS code, max(account_name) AS name
      FROM scm.accounts
     GROUP BY account_code
     ORDER BY account_code`;
  const { layout, mapping, unmatched } = buildCashFlowTree(accounts);
  const checked = validateLayout('rp', layout);
  if (!checked.ok) {
    console.error(`The tree does not validate: ${checked.reason}`);
    process.exit(1);
  }
  const planned = checked.layout;

  log(`MODE=${MODE}  chart ${accounts.length} account(s) → ${countLeaves(planned.blocks.accounts)} line(s) on the tree`);
  log('\n=== THE TREE ===');
  for (const line of outline(planned.blocks.accounts)) log(`  ${line}`);
  log('\n=== ACCOUNT → GROUP ===');
  for (const m of mapping) log(`  ${m.code.padEnd(10)} ${m.flow.padEnd(4)} ${m.group.padEnd(30)} ${m.name}${m.unmatched ? '   (no rule — Office & admin)' : ''}`);
  log(`\n${unmatched.length} account(s) without a rule of their own: ${unmatched.join(', ') || 'none'}`);

  const [current] = await sql`SELECT tree, updated_at, updated_by FROM scm.acc_report_layouts WHERE report = 'rp'`;
  if (current) {
    log(`\n=== STORED TODAY (by ${current.updated_by ?? '—'} on ${String(current.updated_at)}) — the backup ===`);
    log(JSON.stringify(current.tree));
  } else {
    log('\nNo Cash Flow layout is stored today — the report draws the chart\'s own tree.');
  }

  if (!APPLY) {
    log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  await sql`
    INSERT INTO scm.acc_report_layouts (report, tree, updated_at, updated_by)
    VALUES ('rp', ${sql.json(planned)}, now(), ${WHO})
    ON CONFLICT (report) DO UPDATE SET tree = EXCLUDED.tree, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`;
  log('\nAPPLIED: the Cash Flow layout row was written.');
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  const [row] = await check`
    SELECT tree, updated_by, jsonb_typeof(tree) AS kind
      FROM scm.acc_report_layouts WHERE report = 'rp'`;
  await check.end();
  const again = row ? validateLayout('rp', row.tree) : { ok: false, reason: 'no row' };
  const ok = {
    'the row exists and holds a JSON object': Boolean(row) && row.kind === 'object',
    'the stored tree validates as a Cash Flow layout': again.ok,
    'the top level is the planned one, in order': Boolean(row) && Array.isArray(row.tree?.blocks?.accounts) && JSON.stringify(topIds(row.tree)) === JSON.stringify(topIds(planned)),
    'every planned line is stored': Boolean(row) && countLeaves(row.tree?.blocks?.accounts ?? []) === countLeaves(planned.blocks.accounts),
    'updated_by names this seeding': Boolean(row) && row.updated_by === WHO,
  };
  log('\n=== VERIFY (fresh connection) ===');
  let bad = 0;
  for (const [k, v] of Object.entries(ok)) {
    if (!v) bad += 1;
    log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
  }
  if (bad) { console.error('VERIFY FAILED.'); process.exit(1); }
  log('VERIFY OK — the Cash Flow reads the workbook tree; the Layout editor takes it from here.');
} catch (e) {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
}
