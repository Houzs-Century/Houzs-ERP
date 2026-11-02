#!/usr/bin/env node
// check-bank-locks.mjs — READ ONLY. A company's bank-month locks: which months of
// which money account are closed, when, by whom, and the figures they closed on.
// Env: DATABASE_URL, COMPANY_ID, ACCOUNT_CODE (optional).
import postgres from 'postgres';
const CO = Number(process.env.COMPANY_ID || 2);
const ACCT = String(process.env.ACCOUNT_CODE || '').trim();
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '—' : (Number(sen) / 100).toFixed(2));
try {
  const rows = await sql`SELECT account_code, period_month, closing_statement_sen, closing_ledger_sen, difference_sen, statement_count, was_complete, locked_by, locked_at, lock_note, released_by, released_at, release_note
                           FROM scm.acc_bank_month_locks WHERE company_id = ${CO} ${ACCT ? sql`AND account_code = ${ACCT}` : sql``} ORDER BY account_code, period_month, locked_at`;
  for (const r of rows) {
    out(`${r.account_code} ${String(r.period_month instanceof Date ? r.period_month.toISOString() : r.period_month).slice(0, 7)} locked ${r.locked_at instanceof Date ? r.locked_at.toISOString() : r.locked_at} by ${r.locked_by ?? '—'} | stmt ${rm(r.closing_statement_sen)} ledger ${rm(r.closing_ledger_sen)} diff ${rm(r.difference_sen)} files ${r.statement_count} complete ${r.was_complete}${r.lock_note ? ` note "${r.lock_note}"` : ''}${r.released_at ? ` | RELEASED ${r.released_at instanceof Date ? r.released_at.toISOString() : r.released_at} by ${r.released_by} "${r.release_note ?? ''}"` : ''}`);
  }
  out(`${rows.length} lock row(s)`);
} catch (e) { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; } finally { await sql.end(); }
