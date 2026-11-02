#!/usr/bin/env node
// check-claimed-later.mjs — READ ONLY. Entries on a bank account dated BEFORE a
// month that no line up to the month's end claims, but a POSTED line of a LATER
// month does: still outstanding at the month's end, yet left off its carried list
// because the claim of a later month counts as "claimed elsewhere"
// (accounting-bank-months.ts claimedOutside). Their sum against the month's
// unexplained figure. Env: DATABASE_URL, COMPANY_ID, ACCOUNT_CODE, MONTH.
import postgres from 'postgres';
const CO = Number(process.env.COMPANY_ID);
const ACCT = String(process.env.ACCOUNT_CODE ?? '').trim();
const MONTH = String(process.env.MONTH ?? '').trim();
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
try {
  const from = `${MONTH}-01`;
  const [{ to }] = await sql`SELECT ((${from}::date + interval '1 month') - interval '1 day')::date::text AS to`;
  const lines = await sql`
    SELECT l.id, l.booked_on, l.state, l.posted_je_no FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.company_id = ${CO} AND s.account_code = ${ACCT} AND l.state = 'POSTED'`;
  const matches = await sql`SELECT bank_line_id, je_no FROM scm.acc_bank_statement_matches WHERE company_id = ${CO}`;
  const byLine = new Map();
  for (const m of matches) { const a = byLine.get(Number(m.bank_line_id)) ?? []; a.push(String(m.je_no)); byLine.set(Number(m.bank_line_id), a); }
  const claimUpTo = new Set();
  const claimLater = new Map();
  for (const l of lines) {
    const nos = [...String(l.posted_je_no ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...(byLine.get(Number(l.id)) ?? [])];
    for (const n of nos) {
      if (d(l.booked_on) <= to) claimUpTo.add(n);
      else if (!claimLater.has(n)) claimLater.set(n, d(l.booked_on));
    }
  }
  const [first] = await sql`SELECT min(period_from)::text AS f FROM scm.acc_bank_statements WHERE company_id = ${CO} AND account_code = ${ACCT}`;
  const legs = await sql`
    SELECT j.je_no, j.entry_date::text AS day, j.source_type, sum(l.debit_sen - l.credit_sen)::bigint AS net
      FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
     WHERE j.company_id = ${CO} AND l.account_code = ${ACCT} AND j.posted = true AND j.entry_date < ${from}::date AND j.entry_date >= ${first.f}::date
     GROUP BY 1, 2, 3 ORDER BY 2, 1`;
  let sum = 0;
  for (const x of legs) {
    if (claimUpTo.has(x.je_no) || !claimLater.has(x.je_no)) continue;
    sum += Number(x.net);
    out(`  ${x.je_no} dated ${x.day} ${x.source_type} ${Number(x.net) < 0 ? 'out' : 'in'} ${rm(Math.abs(Number(x.net)))} — cleared by a line of ${claimLater.get(x.je_no)}`);
  }
  out(`${ACCT} ${MONTH}: entries before the month, outstanding at ${to}, claimed only by later lines — net ${rm(sum)}`);
} catch (e) { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; } finally { await sql.end(); }
