#!/usr/bin/env node
// check-zanotti-so-months.mjs — READ-ONLY. ZANOTTI sales orders per month (Houzs),
// for the owner's 2026-10-20 「每个月随便两张zanotti brand 的sales order」: how many
// per month (keyed in the ERP vs imported from AutoCount), and two candidates a
// month — confirmed, not cancelled, with lines, the largest and a mid one.
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1).
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const months = await sql`
    SELECT to_char(so_date, 'YYYY-MM') AS month,
           count(*)::int AS n,
           count(*) FILTER (WHERE doc_no LIKE 'HC-SO-2___-%')::int AS erp_keyed
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO} AND upper(coalesce(branding, '')) LIKE '%ZANOTTI%'
       AND status::text NOT IN ('CANCELLED', 'DRAFT') AND so_date IS NOT NULL
     GROUP BY 1 ORDER BY 1 DESC`;
  console.log('month | ZANOTTI orders | keyed in ERP (HC-SO-YYMM-NNN)');
  for (const m of months) console.log(`${m.month} | ${m.n} | ${m.erp_keyed}`);
  const picks = await sql`
    WITH z AS (
      SELECT doc_no, so_date, debtor_name, local_total_sen, line_count, project_id,
             to_char(so_date, 'YYYY-MM') AS month,
             row_number() OVER (PARTITION BY to_char(so_date, 'YYYY-MM') ORDER BY local_total_sen DESC, doc_no) AS rk,
             count(*) OVER (PARTITION BY to_char(so_date, 'YYYY-MM')) AS cnt
        FROM scm.mfg_sales_orders
       WHERE company_id = ${CO} AND upper(coalesce(branding, '')) LIKE '%ZANOTTI%'
         AND status::text NOT IN ('CANCELLED', 'DRAFT') AND so_date IS NOT NULL AND coalesce(line_count, 0) > 0
    )
    SELECT month, doc_no, so_date::text AS so_date, debtor_name, local_total_sen, line_count, project_id, rk, cnt
      FROM z WHERE rk = 1 OR rk = greatest(2, (cnt + 1) / 2)
     ORDER BY month DESC, rk`;
  console.log('\ncandidates (largest + a middle one, per month):');
  for (const p of picks) console.log(`${p.month} ${p.doc_no} ${p.so_date} RM ${(Number(p.local_total_sen) / 100).toFixed(2)} lines ${p.line_count} fair ${p.project_id ?? '—'} (${p.rk}/${p.cnt})`);
} finally { await sql.end(); }
