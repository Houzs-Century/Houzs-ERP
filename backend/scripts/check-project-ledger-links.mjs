#!/usr/bin/env node
// check-project-ledger-links.mjs — READ-ONLY. Where each row of a fair's PMS
// Finance Ledger gets its figure today, and what money never reaches it.
//
// WHY. The owner, 2026-10-19: 「现在 project ledger 有什么资料是链接不齐全的？」.
// For the company's fairs starting FROM → today, per ledger row (Sales, COGS,
// Rental, Setup, Transport S&D, Transport Fee, Commission, Merchandise, Others):
//   - Finance: posted journal legs tagged to the fair (journal_entry_lines.
//     project_id), placed by the account's pms_row (scm/lib/event-books.ts);
//   - typed / auto lines in public.project_finance_lines;
//   - for Sales also the Total Sales box and the Sales Orders linked to the fair.
// And the money that is NOT tagged: posted legs on accounts that name a ledger
// row (scm.accounts.pms_row) with no project_id, since FROM.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-01).
//   npx tsx scripts/check-project-ledger-links.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => Math.round(Number(sen ?? 0) / 100).toLocaleString('en-MY');

/* Same mapping as event-books.ts rowOfCategory. */
const rowOfCategory = (c) => {
  switch (String(c ?? '').trim()) {
    case 'rental': return 'rental';
    case 'setup': return 'setup';
    case 'transport': case 'transport_fee': return 'transport_fee';
    case 'transport_setup_dismantle': return 'transport_setup_dismantle';
    case 'commission': return 'commission';
    case 'cogs': case 'cogs_matt_sofa': case 'cogs_bedframe': case 'cogs_accessories': return 'cogs';
    case 'merchandise': return 'merchandise';
    default: return 'others';
  }
};
const ROWS = ['rental', 'setup', 'transport_setup_dismantle', 'transport_fee', 'commission', 'merchandise', 'others', 'cogs'];

try {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const events = await sql`
    SELECT p.id, p.name, p.brand, p.start_date, pf.total_sales AS box
      FROM public.projects p LEFT JOIN public.project_finance pf ON pf.project_id = p.id
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date >= ${FROM} AND p.start_date <= ${today}`;
  const ids = events.map((e) => Number(e.id));
  const lines = ids.length ? await sql`
    SELECT project_id, kind, category, auto_source IS NOT NULL AS auto, amount
      FROM public.project_finance_lines WHERE archived_at IS NULL AND project_id IN ${sql(ids)}` : [];
  const legs = ids.length ? await sql`
    SELECT l.project_id, l.debit_sen - l.credit_sen AS net_sen, a.pms_row, a.account_type
      FROM scm.journal_entry_lines l JOIN scm.journal_entries je ON je.id = l.journal_entry_id
      LEFT JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.account_code
     WHERE l.company_id = ${CO} AND l.project_id IN ${sql(ids)} AND je.posted = true` : [];
  const sos = ids.length ? await sql`
    SELECT project_id, count(*)::int AS n, sum(local_total_sen)::bigint AS sen
      FROM scm.mfg_sales_orders WHERE project_id IN ${sql(ids)} AND status::text NOT IN ('CANCELLED', 'DRAFT') GROUP BY project_id` : [];
  const soOf = new Map(sos.map((s) => [Number(s.project_id), s]));

  /* Per event, per row: which source has a figure. */
  const tally = {};
  for (const r of ROWS) tally[r] = { finance: 0, typed: 0, auto: 0, none: 0 };
  const sales = { box: 0, salesLines: 0, sos: 0, boxAndSos: 0, sosNoBox: 0, nothing: 0 };
  for (const e of events) {
    const id = Number(e.id);
    const myLines = lines.filter((l) => Number(l.project_id) === id);
    const myLegs = legs.filter((l) => Number(l.project_id) === id);
    for (const r of ROWS) {
      const fin = myLegs.some((l) => (l.pms_row ?? (String(l.account_type).toUpperCase() === 'EXPENSE' ? 'others' : null)) === r && Number(l.net_sen) !== 0);
      const typed = myLines.some((l) => l.kind === 'cost' && !l.auto && rowOfCategory(l.category) === r && Number(l.amount) !== 0);
      const auto = myLines.some((l) => l.kind === 'cost' && l.auto && rowOfCategory(l.category) === r && Number(l.amount) !== 0);
      tally[r][fin ? 'finance' : typed ? 'typed' : auto ? 'auto' : 'none'] += 1;
    }
    const box = Number(e.box ?? 0) > 0;
    const sl = myLines.some((l) => l.kind === 'income' && String(l.category) === 'sales' && !l.auto && Number(l.amount) !== 0);
    const so = soOf.has(id);
    if (box) sales.box += 1;
    if (sl) sales.salesLines += 1;
    if (so) sales.sos += 1;
    if (box && so) sales.boxAndSos += 1;
    if (!box && so) sales.sosNoBox += 1;
    if (!box && !sl && !so) sales.nothing += 1;
  }
  console.log(`company ${CO}: fairs (booths) starting ${FROM} → ${today}: ${events.length}`);
  console.log(`  Sales: Total Sales box filled ${sales.box}; sales lines ${sales.salesLines}; with linked SOs ${sales.sos} (box AND SOs ${sales.boxAndSos}, SOs but no box ${sales.sosNoBox}); nothing at all ${sales.nothing}`);
  console.log('  row | from Finance (PV/AP posted) | typed by hand | auto % | empty');
  for (const r of ROWS) console.log(`  ${r.padEnd(26)} | ${tally[r].finance} | ${tally[r].typed} | ${tally[r].auto} | ${tally[r].none}`);

  /* Money on event accounts that is not tagged to any fair. */
  const untagged = await sql`
    SELECT a.pms_row, l.account_code, a.account_name, je.source_type, count(*)::int AS n, sum(l.debit_sen - l.credit_sen)::bigint AS net_sen
      FROM scm.journal_entry_lines l JOIN scm.journal_entries je ON je.id = l.journal_entry_id
      JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.account_code
     WHERE l.company_id = ${CO} AND je.posted = true AND je.entry_date >= ${FROM}
       AND a.pms_row IS NOT NULL AND l.project_id IS NULL
     GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 4`;
  const tagged = await sql`
    SELECT count(*)::int AS n, sum(l.debit_sen - l.credit_sen)::bigint AS net_sen
      FROM scm.journal_entry_lines l JOIN scm.journal_entries je ON je.id = l.journal_entry_id
      JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.account_code
     WHERE l.company_id = ${CO} AND je.posted = true AND je.entry_date >= ${FROM}
       AND a.pms_row IS NOT NULL AND l.project_id IS NOT NULL`;
  console.log(`\nposted money on event accounts since ${FROM}: tagged to a fair ${tagged[0].n} legs RM ${rm(tagged[0].net_sen)}; NOT tagged:`);
  for (const u of untagged) console.log(`  ${u.pms_row} | ${u.account_code} ${u.account_name} | ${u.source_type} | ${u.n} legs | RM ${rm(u.net_sen)}`);
} finally {
  await sql.end();
}
