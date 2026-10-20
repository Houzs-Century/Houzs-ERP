#!/usr/bin/env node
// check-event-pnl-after.mjs — READ-ONLY. The fairs' Finance Ledger P&L as the
// live code now computes it (ledger fixes #4742 / #4744 / #4745, 2026-10-20),
// for the same fairs check-project-ledger-links.mjs counted on 2026-10-19
// (company COMPANY_ID, not archived / cancelled, starting FROM → today).
//
// Runs the app's own reader — services/eventPnlBatch.ts pnlForProjects, the one
// the Projects list uses — over a D1-compatible client (src/db/d1-compat.ts), so
// the figures are the page's, not a re-implementation. Per row of the "By Total
// Sales" column: where the figure comes from now (books / typed / rate / SO /
// none); plus a few examples.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-01), IDS (optional examples).
//   npx tsx scripts/check-event-pnl-after.mjs

import postgres from 'postgres';
import { d1Compat } from '../src/db/d1-compat.ts';
import { pnlForProjects } from '../src/services/eventPnlBatch.ts';
import { readEventBooksMany } from '../src/scm/lib/event-books.ts';
import { loadCostRates, loadFairSoTotalsMany } from '../src/services/eventPnlInputs.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const env = { DB: d1Compat(() => sql) };
const rm = (n) => Math.round(Number(n ?? 0)).toLocaleString('en-MY');
/* services/projects.ts LEDGER_COST_CATEGORIES (copied: that module pulls the whole route stack). */
const COST_CATEGORIES = ['rental', 'cogs', 'cogs_matt_sofa', 'cogs_bedframe', 'cogs_accessories', 'setup', 'transport',
  'transport_fee', 'transport_setup_dismantle', 'commission', 'merchandise', 'contractor', 'license', 'deposit', 'permit',
  'accommodation', 'staffing', 'marketing', 'misc'];

try {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const events = await sql`
    SELECT p.id, p.name, p.brand, p.start_date::text AS start_date, pf.total_sales
      FROM public.projects p LEFT JOIN public.project_finance pf ON pf.project_id = p.id
     WHERE p.company_id = ${CO} AND p.archived_at IS NULL AND lower(coalesce(p.status, '')) <> 'cancelled'
       AND p.start_date >= ${FROM} AND p.start_date <= ${today}
     ORDER BY p.start_date, p.id`;
  const rows = events.map((e) => ({ id: Number(e.id), brand: e.brand, total_sales: e.total_sales }));
  const pnl = await pnlForProjects(env, rows, CO, COST_CATEGORIES);
  console.log(`company ${CO}: fairs starting ${FROM} → ${today}: ${events.length}; P&L computed for ${pnl.size}`);
  if (pnl.size === 0 && events.length > 0) {
    const ids = rows.map((r) => r.id);
    for (const [name, f] of [
      ['books', () => readEventBooksMany(env.DB, ids, CO)],
      ['orders', () => loadFairSoTotalsMany(env, ids, CO)],
      ['rates', () => loadCostRates(env, rows.map((r) => r.brand))],
    ]) {
      try { const r = await f(); console.log(`  ${name}: ok ${r && r.ok === false ? `(not ok: ${r.reason})` : ''}`); } catch (e) { console.log(`  ${name}: FAILED ${e?.message ?? e}`); }
    }
  }

  const t = {
    sales: { lines: 0, box: 0, so: 0, none: 0 },
    cogs: { typed: 0, so: 0, so_ratio: 0, none: 0 },
    transportFee: { books: 0, typed: 0, rate: 0, none: 0 },
    commission: { books: 0, typed: 0, rate: 0, none: 0 },
    merchandise: { books: 0, typed: 0, rate: 0, none: 0 },
    shared: { rental: 0, setup: 0, transportSetupDismantle: 0, others: 0 },
    bySo: 0, boost: 0,
  };
  let sumSales = 0, sumCogs = 0, sumComm = 0, sumNet = 0;
  for (const e of events) {
    const p = pnl.get(Number(e.id));
    if (!p) continue;
    const s = p.by_sales;
    t.sales[s.salesFrom] += 1;
    t.cogs[s.cogs.from] += 1;
    t.transportFee[s.transportFee.from] += 1;
    t.commission[s.commission.from] += 1;
    t.merchandise[s.merchandise.from] += 1;
    for (const k of Object.keys(t.shared)) if (Number(s[k]) !== 0) t.shared[k] += 1;
    if (p.by_so) t.bySo += 1;
    if (s.commission.boost) t.boost += 1;
    sumSales += s.sales; sumCogs += s.cogs.total; sumComm += s.commission.amount; sumNet += s.netProfit;
  }
  console.log('\n"By Total Sales" column — where each row\'s figure comes from now:');
  for (const [k, v] of Object.entries(t)) console.log(`  ${k}: ${typeof v === 'number' ? v : Object.entries(v).map(([a, b]) => `${a} ${b}`).join(' · ')}`);
  console.log(`  totals: sales RM ${rm(sumSales)} · COGS RM ${rm(sumCogs)} · commission RM ${rm(sumComm)} · net profit RM ${rm(sumNet)}`);

  const wanted = String(process.env.IDS || '').split(',').map((x) => Number(x.trim())).filter(Boolean);
  const bySales = [...events].filter((e) => pnl.get(Number(e.id))).sort((a, b) => pnl.get(Number(b.id)).by_sales.sales - pnl.get(Number(a.id)).by_sales.sales);
  const examples = [...new Set([...wanted, ...bySales.slice(0, 3).map((e) => Number(e.id))])];
  console.log('\nExamples (By Total Sales | By Sales Orders):');
  for (const id of examples) {
    const e = events.find((x) => Number(x.id) === id);
    const p = pnl.get(id);
    if (!e || !p) { console.log(`  #${id}: not in the set`); continue; }
    const c = (col) => col ? `sales ${rm(col.sales)} (${col.salesFrom}) · COGS ${rm(col.cogs.total)} (${col.cogs.from}) · rental ${rm(col.rental)} · setup ${rm(col.setup)} · transport fee ${rm(col.transportFee.amount)} (${col.transportFee.from}) · commission ${rm(col.commission.amount)} (${col.commission.from}${col.commission.boost ? ', boost' : ''}) · merch ${rm(col.merchandise.amount)} (${col.merchandise.from}) · total cost ${rm(col.totalCost)} · net ${rm(col.netProfit)}` : '—';
    console.log(`  #${id} ${e.name} (${e.start_date}, ${e.brand ?? '—'})`);
    console.log(`     Total Sales: ${c(p.by_sales)}`);
    console.log(`     SO (${p.so_count}): ${c(p.by_so)}`);
  }
} finally {
  await sql.end();
}
