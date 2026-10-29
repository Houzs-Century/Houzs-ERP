#!/usr/bin/env node
// check-transport-income.mjs — READ ONLY. What the system holds for the "Transport
// Income" lines of the owner's Logistic Cost Report (owner 2026-10-29: 我想要类似
// 这样的 report): the service lines on sales orders — transportation charges,
// setup / dismantle, delivery — by item code and month, and the other debtor
// bills raised to the group's companies. Env: DATABASE_URL, COMPANY_ID (1),
// FROM (2026-09-01), TO (2026-10-31).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const TO = String(process.env.TO || '2026-10-31');
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  for (const r of await sql`
    SELECT to_char(o.so_date, 'YYYY-MM') AS ym, i.item_group, i.item_code, count(*)::int AS n, coalesce(sum(i.total_sen), 0)::bigint AS sen
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no AND o.company_id = ${CO}
     WHERE o.status <> 'CANCELLED' AND o.so_date BETWEEN ${FROM}::date AND ${TO}::date
       AND (i.item_group ILIKE 'service%' OR i.item_code ~* '(transport|deliver|setup|set up|dismantle|install|shipping|freight)')
     GROUP BY 1, 2, 3 ORDER BY 1, 5 DESC LIMIT 60`) {
    out(`SO lines ${r.ym} [${r.item_group}] ${r.item_code}: ${r.n} lines RM ${rm(r.sen)}`);
  }
  for (const r of await sql`
    SELECT to_char(b.bill_date, 'YYYY-MM') AS ym, d.name AS debtor, count(*)::int AS n, coalesce(sum(b.total_sen), 0)::bigint AS sen
      FROM scm.acc_debtor_bills b JOIN scm.acc_debtors d ON d.id = b.debtor_id
     WHERE b.company_id = ${CO} AND b.status <> 'CANCELLED' AND b.bill_date BETWEEN ${FROM}::date AND ${TO}::date
     GROUP BY 1, 2 ORDER BY 1, 4 DESC LIMIT 40`) {
    out(`ODB ${r.ym} ${r.debtor}: ${r.n} bills RM ${rm(r.sen)}`);
  }
} finally {
  await sql.end();
}
