#!/usr/bin/env node
// check-logistics-accounts.mjs — READ ONLY. Which accounts of one company's chart
// could feed each line of the owner's "Logistic & Operation Cost" workbook (owner
// 2026-10-29: 我想要类似这样的 report): transport / setup income, outsource
// transport by region, fuel / upkeep / hire purchase / road tax & insurance /
// salaries, warehouse rental / utilities — with what each booked per month.
// Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-09-01), TO (2026-10-31).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const TO = String(process.env.TO || '2026-10-31');
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const PATTERN = '(transport|deliver|freight|lorry|lori|petrol|toll|tol |diesel|upkeep|hire purchase|h\\.p|hp |instal|road ?tax|insurance|salar|wage|allowance|epf|socso|manpower|warehouse|rental|accommodation|hostel|water|electric|setup|set up|dismantle|installation|permit|shipping|sea freight|forwarding|logistic)';
try {
  const rows = await sql`
    SELECT a.account_code, a.account_name, a.account_type, a.is_active,
           coalesce(sum(v.debit_sen - v.credit_sen) FILTER (WHERE to_char(v.entry_date, 'YYYY-MM') = ${FROM.slice(0, 7)}), 0)::bigint AS m1,
           coalesce(sum(v.debit_sen - v.credit_sen) FILTER (WHERE to_char(v.entry_date, 'YYYY-MM') = ${TO.slice(0, 7)}), 0)::bigint AS m2,
           count(v.line_id)::int AS n
      FROM scm.accounts a
      LEFT JOIN scm.v_gl_entries v ON v.company_id = a.company_id AND v.account_code = a.account_code
           AND v.entry_date BETWEEN ${FROM}::date AND ${TO}::date AND NOT v.opening
           AND NOT coalesce(v.reversed, false) AND v.reversed_by_je IS NULL
     WHERE a.company_id = ${CO} AND a.account_type IN ('INCOME', 'EXPENSE')
       AND a.account_name ~* ${PATTERN}
     GROUP BY 1, 2, 3, 4 ORDER BY a.account_type, a.account_code`;
  for (const r of rows) {
    out(`${r.account_type} ${r.account_code} ${r.account_name}${r.is_active ? '' : ' (inactive)'} | ${FROM.slice(0, 7)} ${rm(r.m1)} | ${TO.slice(0, 7)} ${rm(r.m2)} | ${r.n} lines`);
  }
} finally {
  await sql.end();
}
