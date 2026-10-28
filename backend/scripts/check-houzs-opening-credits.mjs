#!/usr/bin/env node
// check-houzs-opening-credits.mjs — READ ONLY. The opening supplier credits
// (AutoCount payments not knocked off at 31/08) per supplier, beside the same
// supplier's opening bills still owing (owner 2026-10-28: 感觉不太对，有这么多cn吗?).
// Env: DATABASE_URL, COMPANY_ID (1).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const rows = await sql`
    WITH cr AS (
      SELECT supplier_id, count(*)::int AS n, sum(total_sen)::bigint AS sen,
             coalesce(sum(a.applied), 0)::bigint AS applied
        FROM scm.acc_credit_notes n
        LEFT JOIN LATERAL (SELECT sum(applied_sen) AS applied FROM scm.acc_credit_note_allocations WHERE note_id = n.id) a ON true
       WHERE n.company_id = ${CO} AND n.kind = 'SCN' AND n.opening AND n.status = 'POSTED'
       GROUP BY supplier_id),
    bl AS (
      SELECT supplier_id, count(*)::int AS n, sum(total_sen - paid_sen)::bigint AS owed
        FROM scm.ap_invoices
       WHERE company_id = ${CO} AND opening AND status IN ('POSTED', 'PARTIALLY_PAID')
       GROUP BY supplier_id)
    SELECT s.code, s.name, cr.n AS credits, cr.sen AS credit_sen, cr.applied, coalesce(bl.n, 0) AS bills, coalesce(bl.owed, 0)::bigint AS bill_owed
      FROM cr JOIN scm.suppliers s ON s.id = cr.supplier_id LEFT JOIN bl ON bl.supplier_id = cr.supplier_id
     ORDER BY cr.sen DESC`;
  for (const r of rows) console.log(`ROW|${r.code} ${r.name} | credits ${r.credits} RM ${rm(r.credit_sen)} (knocked off ${rm(r.applied)}) | opening bills owing ${r.bills} RM ${rm(r.bill_owed)}`);
  const [t] = await sql`SELECT count(*)::int AS n, sum(total_sen)::bigint AS sen FROM scm.acc_credit_notes WHERE company_id = ${CO} AND kind = 'SCN' AND opening AND status = 'POSTED'`;
  console.log(`ROW|total opening credits ${t.n} RM ${rm(t.sen)}`);
} finally {
  await sql.end();
}
