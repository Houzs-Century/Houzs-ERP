#!/usr/bin/env node
// check-previous-keyed.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-11 (previous-system payment records, taken in nowhere): the payments a
// salesperson keyed in this system dated BEFORE the books start, which all carry an
// entry in the books — when is that entry dated, is it on a bank line or a merchant
// line already, and do they count on the two lists. Counts, dates, yes/no only.
// Env: DATABASE_URL, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);

try {
  await sql.begin('read only', async (tx) => {
    const [open] = await tx`SELECT to_char(min(entry_date), 'YYYY-MM-DD') AS day FROM scm.journal_entries
                            WHERE company_id = ${CO} AND source_type = 'OPENING' AND posted = true`;
    const START = open?.day;
    row('BOOKS_START', START ?? 'none');
    if (!START) return;
    const rows = await tx`
      SELECT p.id::text AS id, p.method, to_char(p.paid_at, 'YYYY-MM') AS paid_month,
             to_char(j.entry_date, 'YYYY-MM-DD') AS entry_day, j.je_no,
             EXISTS (SELECT 1 FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id
                      WHERE m.company_id = p.company_id AND m.je_no = j.je_no AND l.state = 'POSTED') AS on_bank,
             EXISTS (SELECT 1 FROM scm.acc_settlement_matches s WHERE s.company_id = p.company_id
                      AND s.payment_source = 'SOPAY' AND s.payment_id = p.id::text) AS on_merchant_line,
             (SELECT string_agg(DISTINCT jl.account_code, ',') FROM scm.journal_entry_lines jl
               WHERE jl.journal_entry_id = j.id AND jl.debit_sen > 0) AS debit_accounts
        FROM scm.mfg_sales_order_payments p
        JOIN scm.journal_entries j ON j.company_id = p.company_id AND j.source_type = 'SOPAY' AND j.source_doc_no = p.id::text
                                  AND j.posted AND NOT coalesce(j.reversed, false)
       WHERE p.company_id = ${CO} AND p.method NOT IN ('imported', 'cash', 'converted') AND p.paid_at < ${START}`;
    const by = (f) => Object.entries(rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort().map(([k, n]) => `${k} ${n}`).join(', ');
    row('KEYED_BEFORE_BOOKS', `rows ${rows.length}`, `by method ${by((r) => r.method)}`, `paid ${by((r) => r.paid_month)}`);
    row('ENTRY_DATED', by((r) => (r.entry_day < START ? 'before books start' : r.entry_day.slice(0, 7))));
    row('DEBITS', by((r) => r.debit_accounts ?? '—'));
    row('ALREADY', `on a posted bank line ${rows.filter((r) => r.on_bank).length}`, `on a merchant line ${rows.filter((r) => r.on_merchant_line).length}`);
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
