// ----------------------------------------------------------------------------
// check-bank-month-opening.mjs — READ ONLY. Why a bank month has no opening
// balance (the owner's 2026-11-03 question on Maybank 310-0010, October 2026):
// for one account code and two months, every statement file (its period and
// whether it prints an opening / closing balance), every typed month-end
// balance, and the month locks. Writes nothing; MODE is ignored.
//
// Env: DATABASE_URL, ACCOUNT_CODE (default 310-0010), MONTHS (default
// 2026-09,2026-10).
// ----------------------------------------------------------------------------

import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });
const code = process.env.ACCOUNT_CODE || '310-0010';
const months = (process.env.MONTHS || '2026-09,2026-10').split(',').map((m) => m.trim());
const firstDay = (m) => `${m}-01`;
const lastDay = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const from = firstDay(months[0]);
const to = lastDay(months[months.length - 1]);
const d = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).slice(0, 10));
const rm = (sen) => (sen == null ? '—' : (Number(sen) / 100).toFixed(2));

try {
  const ids = await sql`select distinct company_id from scm.acc_bank_statements where account_code = ${code} order by company_id`;
  for (const co of ids.map((r) => ({ id: r.company_id, code: String(r.company_id) }))) {
    const stmts = await sql`
      select id, file_name, period_from, period_to, line_count, in_sen, out_sen, opening_balance_sen, closing_balance_sen, status, created_at
      from scm.acc_bank_statements
      where company_id = ${co.id} and account_code = ${code} and period_to >= ${from} and period_from <= ${to}
      order by period_from, period_to`;
    const typed = await sql`
      select period_month, closing_sen, typed_by, typed_at
      from scm.acc_bank_month_balances
      where company_id = ${co.id} and account_code = ${code} and period_month between ${from} and ${to}
      order by period_month`;
    const locks = await sql`
      select period_month, locked_by, locked_at, released_at
      from scm.acc_bank_month_locks
      where company_id = ${co.id} and account_code = ${code} and period_month between ${from} and ${to}
      order by period_month, locked_at`;
    if (stmts.length + typed.length + locks.length === 0) continue;
    console.log(`\n=== company ${co.id} ${co.code} · account ${code} · ${months.join(' → ')}`);
    console.log('STATEMENT FILES');
    for (const s of stmts) {
      console.log(`  ${d(s.period_from)} → ${d(s.period_to)} | opening ${rm(s.opening_balance_sen)} | closing ${rm(s.closing_balance_sen)} | in ${rm(s.in_sen)} out ${rm(s.out_sen)} | ${s.line_count} lines | ${s.status} | ${s.file_name}`);
    }
    console.log('TYPED MONTH-END BALANCES');
    for (const t of typed) console.log(`  ${d(t.period_month)} | closing ${rm(t.closing_sen)} | by ${t.typed_by} at ${d(t.typed_at)}`);
    if (typed.length === 0) console.log('  (none)');
    console.log('LOCKS');
    for (const l of locks) console.log(`  ${d(l.period_month)} | locked by ${l.locked_by} at ${d(l.locked_at)}${l.released_at ? ` | RELEASED ${d(l.released_at)}` : ''}`);
    if (locks.length === 0) console.log('  (none)');
  }
} finally {
  await sql.end();
}
