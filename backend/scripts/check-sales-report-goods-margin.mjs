#!/usr/bin/env node
// check-sales-report-goods-margin.mjs — READ-ONLY. Before the Sales Report
// (GET /scm/reports/fair-report) works its Margin % on goods only (owner
// 2026-10-22: delivery / installation income does not count): do the SO
// header goods buckets, the DO lines and the SI lines carry enough to tell
// goods from service on the report's own row set (status not DRAFT/CANCELLED)?
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (v) => (Number(v ?? 0) / 100).toFixed(2);
const pct = (rev, cost) => (Number(rev) === 0 ? '-' : (((Number(rev) - Number(cost)) / Number(rev)) * 100).toFixed(1) + '%');
const GOODS = `(COALESCE(o.mattress_sofa_sen,0)+COALESCE(o.bedframe_sen,0)+COALESCE(o.accessories_sen,0)+COALESCE(o.others_sen,0))`;
const COST5 = `(COALESCE(o.mattress_sofa_cost_sen,0)+COALESCE(o.bedframe_cost_sen,0)+COALESCE(o.accessories_cost_sen,0)+COALESCE(o.others_cost_sen,0)+COALESCE(o.service_cost_sen,0))`;
const SVC = (t) => `(upper(COALESCE(${t}.item_group,'')) LIKE '%SERVICE%' OR (upper(trim(COALESCE(${t}.item_code,''))) LIKE 'SVC-%' AND length(trim(${t}.item_code)) > 4))`;
const LIVE = `o.status::text NOT IN ('DRAFT','CANCELLED')`;
async function step(name, fn) {
  try { await fn(); } catch (e) { console.log(`ROW|${name} FAILED: ${e.message}`); }
}
try {
  await step('so', async () => {
    const rows = await sql.unsafe(`
      SELECT o.company_id,
             count(*) AS n,
             count(*) FILTER (WHERE ${GOODS} = 0 AND COALESCE(o.local_total_sen,0) > 0) AS no_goods_split,
             count(*) FILTER (WHERE COALESCE(o.local_total_sen,0) <> ${GOODS} + COALESCE(o.service_sen,0)) AS total_ne_split,
             sum(COALESCE(o.local_total_sen,0) - ${GOODS} - COALESCE(o.service_sen,0)) AS total_minus_split,
             count(*) FILTER (WHERE COALESCE(o.total_cost_sen,0) <> ${COST5}) AS cost_ne_split,
             count(*) FILTER (WHERE COALESCE(o.service_sen,0) <> 0) AS with_service,
             count(*) FILTER (WHERE COALESCE(o.service_cost_sen,0) <> 0) AS with_service_cost,
             sum(COALESCE(o.local_total_sen,0)) AS amount, sum(${GOODS}) AS goods, sum(COALESCE(o.service_sen,0)) AS service,
             sum(COALESCE(o.total_cost_sen,0)) AS cost, sum(COALESCE(o.service_cost_sen,0)) AS service_cost
        FROM scm.mfg_sales_orders o WHERE ${LIVE} GROUP BY 1 ORDER BY 1`);
    for (const r of rows) {
      console.log(`ROW|SO co${r.company_id}: n=${r.n} noGoodsSplit=${r.no_goods_split} total≠goods+svc=${r.total_ne_split} (Σdiff ${rm(r.total_minus_split)}) cost≠5buckets=${r.cost_ne_split} withService=${r.with_service} withServiceCost=${r.with_service_cost}`);
      console.log(`ROW|SO co${r.company_id}: amount ${rm(r.amount)} goods ${rm(r.goods)} service ${rm(r.service)} cost ${rm(r.cost)} serviceCost ${rm(r.service_cost)} | margin now ${pct(r.amount, r.cost)} goods-only ${pct(r.goods, Number(r.cost) - Number(r.service_cost))}`);
    }
    const odd = await sql.unsafe(`
      SELECT o.company_id, o.doc_no, o.so_date::text AS so_date, o.status::text AS status, o.local_total_sen, ${GOODS} AS goods, o.service_sen, o.delivery_fee_sen, o.total_cost_sen, o.service_cost_sen
        FROM scm.mfg_sales_orders o
       WHERE ${LIVE} AND COALESCE(o.local_total_sen,0) <> ${GOODS} + COALESCE(o.service_sen,0)
       ORDER BY abs(COALESCE(o.local_total_sen,0) - ${GOODS} - COALESCE(o.service_sen,0)) DESC LIMIT 25`);
    for (const r of odd) console.log(`ROW|  odd co${r.company_id} ${r.doc_no} ${r.so_date} ${r.status} total ${rm(r.local_total_sen)} goods ${rm(r.goods)} svc ${rm(r.service_sen)} hdrFee ${rm(r.delivery_fee_sen)} cost ${rm(r.total_cost_sen)} svcCost ${rm(r.service_cost_sen)}`);
    const months = await sql.unsafe(`
      SELECT o.company_id, to_char(o.so_date, 'YYYY-MM') AS m, count(*) AS n,
             count(*) FILTER (WHERE COALESCE(o.local_total_sen,0) <> ${GOODS} + COALESCE(o.service_sen,0)) AS odd,
             count(*) FILTER (WHERE ${GOODS} = 0 AND COALESCE(o.local_total_sen,0) > 0) AS no_goods
        FROM scm.mfg_sales_orders o WHERE ${LIVE} GROUP BY 1, 2 ORDER BY 1, 2`);
    for (const r of months) console.log(`ROW|  month co${r.company_id} ${r.m}: n=${r.n} odd=${r.odd} noGoods=${r.no_goods}`);
  });
  await step('do', async () => {
    const rows = await sql.unsafe(`
      SELECT d.company_id, count(*) AS lines,
             count(*) FILTER (WHERE ${SVC('i')}) AS svc_lines,
             count(*) FILTER (WHERE ${SVC('i')} AND COALESCE(i.ship_cost_sen, i.unit_cost_sen, 0) <> 0) AS svc_lines_with_cost,
             sum(CASE WHEN ${SVC('i')} THEN COALESCE(i.ship_cost_sen, i.unit_cost_sen, 0) * i.qty ELSE 0 END) AS svc_cost,
             sum(CASE WHEN ${SVC('i')} THEN 0 ELSE COALESCE(i.ship_cost_sen, i.unit_cost_sen, 0) * i.qty END) AS goods_cost,
             count(*) FILTER (WHERE i.item_group IS NULL) AS null_group
        FROM scm.delivery_order_items i
        JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
        JOIN scm.mfg_sales_orders o ON o.doc_no = d.so_doc_no
       WHERE ${LIVE} GROUP BY 1 ORDER BY 1`);
    for (const r of rows) console.log(`ROW|DO co${r.company_id}: lines=${r.lines} svcLines=${r.svc_lines} svcLinesWithCost=${r.svc_lines_with_cost} svcCost ${rm(r.svc_cost)} goodsCost ${rm(r.goods_cost)} nullGroup=${r.null_group}`);
  });
  await step('si', async () => {
    const rows = await sql.unsafe(`
      WITH li AS (
        SELECT i.sales_invoice_id, count(*) AS n,
               sum(COALESCE(i.line_total_sen,0)) AS lt,
               sum(CASE WHEN ${SVC('i')} THEN COALESCE(i.line_total_sen,0) ELSE 0 END) AS svc_lt,
               sum(CASE WHEN ${SVC('i')} THEN COALESCE(i.line_cost_sen, i.unit_cost_sen * i.qty, 0) ELSE 0 END) AS svc_cost,
               sum(COALESCE(i.line_cost_sen, i.unit_cost_sen * i.qty, 0)) AS cost
          FROM scm.sales_invoice_items i GROUP BY 1)
      SELECT s.company_id, count(*) AS invoices,
             count(*) FILTER (WHERE li.n IS NULL) AS no_lines,
             count(*) FILTER (WHERE COALESCE(li.lt,0) <> COALESCE(s.total_sen,0)) AS total_ne_lines,
             sum(COALESCE(s.total_sen,0) - COALESCE(li.lt,0)) AS total_minus_lines,
             count(*) FILTER (WHERE COALESCE(li.svc_lt,0) <> COALESCE(s.service_sen,0)) AS svc_ne_hdr,
             sum(COALESCE(s.total_sen,0)) AS total, sum(COALESCE(li.svc_lt,0)) AS svc, sum(COALESCE(li.svc_cost,0)) AS svc_cost,
             sum(COALESCE(li.cost,0)) AS cost
        FROM scm.sales_invoices s
        JOIN scm.mfg_sales_orders o ON o.doc_no = s.so_doc_no
        LEFT JOIN li ON li.sales_invoice_id = s.id
       WHERE ${LIVE} GROUP BY 1 ORDER BY 1`);
    for (const r of rows) console.log(`ROW|SI co${r.company_id}: invoices=${r.invoices} noLines=${r.no_lines} total≠lines=${r.total_ne_lines} (Σdiff ${rm(r.total_minus_lines)}) svcLines≠hdrSvc=${r.svc_ne_hdr} | total ${rm(r.total)} svc ${rm(r.svc)} svcCost ${rm(r.svc_cost)} cost ${rm(r.cost)} | margin now ${pct(r.total, r.cost)} goods-only ${pct(Number(r.total) - Number(r.svc), Number(r.cost) - Number(r.svc_cost))}`);
  });
} finally { await sql.end(); }
