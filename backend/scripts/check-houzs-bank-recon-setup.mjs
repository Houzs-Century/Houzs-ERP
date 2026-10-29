#!/usr/bin/env node
// check-houzs-bank-recon-setup.mjs — READ ONLY. What Houzs's bank recon needs
// before its first statement (owner 2026-10-29: houzs 现在bank statement recon
// 要setup bank 先？): every money account in the chart with its PV letter, its
// statement setup, statements / locks / typed balances, and its ledger since
// the books start; then every company's statement setups, to copy from.
// Env: DATABASE_URL, COMPANY_ID (1).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const [bs] = await sql`SELECT books_start_date::text AS d FROM scm.acc_company_settings WHERE company_id = ${CO}`;
  console.log(`ROW|company ${CO} books start ${bs?.d ?? '-'}`);

  const rows = await sql`
    SELECT a.account_code, a.account_name, a.is_active,
           l.letter,
           c.bank_code, c.account_no, c.statement_format, c.is_active AS cfg_active,
           (SELECT count(*)::int FROM scm.acc_bank_statements s
             WHERE s.company_id = a.company_id AND s.account_code = a.account_code) AS stmts,
           (SELECT count(*)::int FROM scm.acc_bank_month_locks k
             WHERE k.company_id = a.company_id AND k.account_code = a.account_code AND k.released_at IS NULL) AS locks,
           (SELECT count(*)::int FROM scm.acc_bank_month_balances b
             WHERE b.company_id = a.company_id AND b.account_code = a.account_code) AS typed,
           g.open_sen, g.n_sep, g.in_sep, g.out_sep, g.n_after, g.bal_sen, g.last_day
      FROM scm.accounts a
      LEFT JOIN scm.acc_bank_letters l ON l.company_id = a.company_id AND l.account_code = a.account_code
      LEFT JOIN scm.acc_bank_statement_config c ON c.company_id = a.company_id AND c.account_code = a.account_code
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(v.debit_sen - v.credit_sen) FILTER (WHERE v.opening), 0)::bigint AS open_sen,
               count(*) FILTER (WHERE NOT v.opening AND v.entry_date BETWEEN '2026-09-01' AND '2026-09-30')::int AS n_sep,
               coalesce(sum(v.debit_sen) FILTER (WHERE NOT v.opening AND v.entry_date BETWEEN '2026-09-01' AND '2026-09-30'), 0)::bigint AS in_sep,
               coalesce(sum(v.credit_sen) FILTER (WHERE NOT v.opening AND v.entry_date BETWEEN '2026-09-01' AND '2026-09-30'), 0)::bigint AS out_sep,
               count(*) FILTER (WHERE NOT v.opening AND v.entry_date > '2026-09-30')::int AS n_after,
               coalesce(sum(v.debit_sen - v.credit_sen), 0)::bigint AS bal_sen,
               max(v.entry_date)::text AS last_day
          FROM scm.v_gl_entries v
         WHERE v.company_id = a.company_id AND v.account_code = a.account_code) g ON true
     WHERE a.company_id = ${CO} AND a.acc_money
     ORDER BY a.account_code`;
  for (const r of rows) {
    console.log(`ROW|${r.account_code} ${r.account_name}${r.is_active ? '' : ' (inactive)'} | letter ${r.letter ?? '-'}`
      + ` | statement setup ${r.bank_code ? `${r.bank_code} ${r.account_no ?? 'no acct no.'} ${r.statement_format}${r.cfg_active ? '' : ' (off)'}` : 'NONE'}`
      + ` | statements ${r.stmts}, locks ${r.locks}, typed ${r.typed}`
      + ` | opening ${rm(r.open_sen)} | Sep ${r.n_sep} lines in ${rm(r.in_sep)} out ${rm(r.out_sep)} | after Sep ${r.n_after} lines | balance now ${rm(r.bal_sen)} | last ${r.last_day ?? '-'}`);
  }

  const cfgs = await sql`
    SELECT c.company_id, c.account_code, a.account_name, c.bank_code, c.account_no, c.statement_format, c.delimiter,
           c.amount_format, c.credit_indicator, c.column_map, c.is_active
      FROM scm.acc_bank_statement_config c
      LEFT JOIN scm.accounts a ON a.company_id = c.company_id AND a.account_code = c.account_code
     ORDER BY c.company_id, c.account_code`;
  for (const c of cfgs) {
    console.log(`CFG|co ${c.company_id} ${c.account_code} ${c.account_name ?? '?'} | ${c.bank_code} ${c.account_no ?? '-'} | ${c.statement_format}`
      + ` delim ${c.delimiter == null ? 'comma' : JSON.stringify(c.delimiter)} ${c.amount_format} ind ${c.credit_indicator}${c.is_active ? '' : ' (off)'}`
      + ` | ${JSON.stringify(c.column_map)}`);
  }

  const [st] = await sql`SELECT count(*)::int AS n FROM scm.acc_bank_statements WHERE company_id = ${CO}`;
  console.log(`ROW|company ${CO} statements filed in all: ${st.n}`);
} finally {
  await sql.end();
}
