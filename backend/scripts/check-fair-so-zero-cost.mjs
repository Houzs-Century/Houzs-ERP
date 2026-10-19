#!/usr/bin/env node
// check-fair-so-zero-cost.mjs — READ-ONLY. How complete the cost is on the
// Sales Orders linked to recent fairs — the figure a "COGS from the SOs" ledger
// row would show (owner 2026-10-19, 「so 的成本现在如何提取？」).
//
// Line cost is snapshotted at save from Product Maintenance and the nightly
// restamp fills 0-cost lines once the product has a cost; service lines carry
// no cost by design. Counts, for SOs linked to fairs starting FROM onward (not
// cancelled / draft), the goods lines still at cost 0 and the sales they carry.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-01).
//   npx tsx scripts/check-fair-so-zero-cost.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => Math.round(Number(sen ?? 0) / 100).toLocaleString('en-MY');
try {
  const r = await sql`
    WITH so AS (
      SELECT s.doc_no FROM scm.mfg_sales_orders s JOIN public.projects p ON p.id = s.project_id
       WHERE s.company_id = ${CO} AND p.start_date >= ${FROM} AND s.status::text NOT IN ('CANCELLED', 'DRAFT')
    )
    SELECT (lower(coalesce(i.item_group, '')) LIKE '%service%') AS service,
           (coalesce(i.line_cost_sen, 0) = 0) AS zero_cost,
           count(*)::int AS lines, sum(coalesce(i.total_sen, 0))::bigint AS sales_sen, sum(coalesce(i.line_cost_sen, 0))::bigint AS cost_sen
      FROM scm.mfg_sales_order_items i JOIN so ON so.doc_no = i.doc_no
     WHERE coalesce(i.cancelled, false) = false
     GROUP BY 1, 2 ORDER BY 1, 2`;
  console.log(`company ${CO}, lines on SOs linked to fairs starting ${FROM} onward:`);
  for (const x of r) console.log(`  ${x.service ? 'service' : 'goods  '} | cost ${x.zero_cost ? '0   ' : 'set '} | ${x.lines} lines | sales RM ${rm(x.sales_sen)} | cost RM ${rm(x.cost_sen)}`);
} finally {
  await sql.end();
}
