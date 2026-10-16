#!/usr/bin/env node
// check-event-pnl-sources.mjs — READ-ONLY. Where each event's P&L figures come
// from, for the events starting in a window.
//
// WHY. The owner, 2026-10-16, on the Projects list and an event's Financial
// Snapshot: 「为什么没有cost / 为什么有些没有sales / 有sales了这些也不会自动算」.
// Per event it prints:
//   - the Total Sales box (project_finance.total_sales);
//   - ledger sales lines and Sales-section entries;
//   - COGS and rental lines;
//   - the auto (% of sales) rows and any hand-typed commission;
//   - the brand's rate card;
//   - the Sales Orders linked to the event (count, amount, goods cost).
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM / TO (YYYY-MM-DD, default September 2026).
//   npx tsx scripts/check-event-pnl-sources.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const TO = String(process.env.TO || '2026-09-30');
const rm = (v) => (v == null ? '—' : Number(v).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const rows = await sql`
    WITH p AS (
      SELECT id, name, brand, stage, start_date, end_date
        FROM public.projects
       WHERE company_id = ${CO} AND archived_at IS NULL AND start_date >= ${FROM} AND start_date <= ${TO}
    ),
    l AS (
      SELECT project_id,
             SUM(CASE WHEN kind = 'income' AND category = 'sales' AND auto_source IS NULL THEN amount ELSE 0 END) AS ledger_sales,
             SUM(CASE WHEN kind = 'cost' AND category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories') THEN amount ELSE 0 END) AS cogs,
             SUM(CASE WHEN kind = 'cost' AND category = 'rental' THEN amount ELSE 0 END) AS rental,
             SUM(CASE WHEN kind = 'cost' AND auto_source IS NOT NULL THEN amount ELSE 0 END) AS auto_cost,
             SUM(CASE WHEN kind = 'cost' AND category = 'commission' AND auto_source IS NULL THEN amount ELSE 0 END) AS typed_commission
        FROM public.project_finance_lines
       WHERE archived_at IS NULL AND project_id IN (SELECT id FROM p)
       GROUP BY project_id
    ),
    se AS (
      SELECT project_id, SUM(amount) AS entries_sales
        FROM public.sales_entries WHERE project_id IN (SELECT id FROM p) GROUP BY project_id
    ),
    so AS (
      SELECT project_id, COUNT(*) AS n, SUM(local_total_sen) AS amount_sen, SUM(total_cost_sen) AS cost_sen
        FROM scm.mfg_sales_orders
       WHERE project_id IN (SELECT id FROM p) AND status::text NOT IN ('DRAFT', 'CANCELLED')
       GROUP BY project_id
    )
    SELECT p.id, p.name, p.brand, p.stage, p.start_date,
           pf.total_sales AS box_sales,
           COALESCE(l.ledger_sales, 0) AS ledger_sales, COALESCE(se.entries_sales, 0) AS entries_sales,
           COALESCE(l.cogs, 0) AS cogs, COALESCE(l.rental, 0) AS rental,
           COALESCE(l.auto_cost, 0) AS auto_cost, COALESCE(l.typed_commission, 0) AS typed_commission,
           COALESCE(so.n, 0) AS so_n, COALESCE(so.amount_sen, 0) AS so_amount_sen, COALESCE(so.cost_sen, 0) AS so_cost_sen,
           r.brand IS NOT NULL AS has_rate, r.transport_pct, r.merchandise_pct, r.commission_normal_pct, r.commission_boost_pct
      FROM p
      LEFT JOIN public.project_finance pf ON pf.project_id = p.id
      LEFT JOIN l ON l.project_id = p.id
      LEFT JOIN se ON se.project_id = p.id
      LEFT JOIN so ON so.project_id = p.id
      LEFT JOIN public.project_cost_rates r ON r.brand = p.brand
     ORDER BY p.start_date, p.name`;

  console.log(`company ${CO}, events starting ${FROM} → ${TO}: ${rows.length}`);
  console.log(['id', 'start', 'stage', 'brand', 'box_sales', 'ledger_sales', 'entries', 'cogs', 'rental', 'auto', 'typed_comm',
    'so_n', 'so_amount', 'so_cost', 'rate', 'name'].join('\t'));
  for (const r of rows) {
    console.log([
      r.id, r.start_date, r.stage, r.brand ?? '—', rm(r.box_sales), rm(r.ledger_sales), rm(r.entries_sales), rm(r.cogs), rm(r.rental),
      rm(r.auto_cost), rm(r.typed_commission), r.so_n, rm(Number(r.so_amount_sen) / 100), rm(Number(r.so_cost_sen) / 100),
      r.has_rate ? `${r.transport_pct}/${r.merchandise_pct}/${r.commission_normal_pct}${r.commission_boost_pct != null ? `→${r.commission_boost_pct}` : ''}` : 'none',
      r.name,
    ].join('\t'));
  }
  const n = (f) => rows.filter(f).length;
  console.log(`\nsummary: box sales>0 ${n((r) => Number(r.box_sales) > 0)} · ledger sales>0 ${n((r) => Number(r.ledger_sales) > 0)}`
    + ` · entries>0 ${n((r) => Number(r.entries_sales) > 0)} · cogs>0 ${n((r) => Number(r.cogs) > 0)} · auto>0 ${n((r) => Number(r.auto_cost) > 0)}`
    + ` · with SOs ${n((r) => Number(r.so_n) > 0)} · sales 0 but SOs ${n((r) => Number(r.box_sales || 0) + Number(r.ledger_sales) + Number(r.entries_sales) === 0 && Number(r.so_n) > 0)}`);
} finally {
  await sql.end();
}
