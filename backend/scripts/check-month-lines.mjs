#!/usr/bin/env node
// check-month-lines.mjs — READ ONLY. Every bank line of one account's month with
// what it is matched to, and whether that entry still counts: reversed since, or
// dated outside the month, or gone. What can turn a month that tallied into one
// that does not without a single new line. Env: DATABASE_URL, COMPANY_ID, ACCOUNT_CODE, MONTH.
import postgres from 'postgres';
const CO = Number(process.env.COMPANY_ID);
const ACCT = String(process.env.ACCOUNT_CODE ?? '').trim();
const MONTH = String(process.env.MONTH ?? '').trim();
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
try {
  const lines = await sql`
    SELECT l.id, l.booked_on, l.amount_sen, l.state, l.posted_je_no, l.description, l.updated_at
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.company_id = ${CO} AND s.account_code = ${ACCT}
       AND l.booked_on >= ${MONTH + '-01'}::date AND l.booked_on < (${MONTH + '-01'}::date + interval '1 month')
     ORDER BY l.booked_on, l.id`;
  let flagged = 0;
  for (const l of lines) {
    const ms = await sql`SELECT je_no FROM scm.acc_bank_statement_matches WHERE company_id = ${CO} AND bank_line_id = ${l.id}`;
    const nos = [...new Set([...ms.map((m) => m.je_no), ...String(l.posted_je_no ?? '').split(',').map((s) => s.trim()).filter(Boolean)])];
    const jes = nos.length ? await sql`SELECT je_no, entry_date, reversed, source_type, created_at FROM scm.journal_entries WHERE company_id = ${CO} AND je_no = ANY(${nos})` : [];
    const notes = [];
    for (const n of nos) {
      const j = jes.find((x) => x.je_no === n);
      if (!j) notes.push(`${n} GONE`);
      else if (j.reversed) notes.push(`${n} REVERSED`);
      else if (d(j.entry_date).slice(0, 7) !== MONTH) notes.push(`${n} dated ${d(j.entry_date)}`);
    }
    if (notes.length || l.state === 'OPEN') {
      flagged += 1;
      out(`line ${l.id} ${d(l.booked_on)} ${rm(l.amount_sen)} ${l.state} "${String(l.description).slice(0, 50)}" → ${nos.join(', ') || '—'} ${notes.join(' ; ')} (line updated ${d(l.updated_at)})`);
    }
  }
  out(`${lines.length} line(s) in ${ACCT} ${MONTH}; ${flagged} flagged`);
} catch (e) { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; } finally { await sql.end(); }
