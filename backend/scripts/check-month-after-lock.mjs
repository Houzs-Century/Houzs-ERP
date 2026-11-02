#!/usr/bin/env node
// check-month-after-lock.mjs — READ ONLY. A closed bank month as it stands TODAY:
// the same reconciliation the Lock button runs (accounting-bank-months.ts
// loadMonthForLock), the snapshot it was closed on, and every journal line on the
// account dated in that month but written AFTER the lock — what moved under a
// closed month. Nothing is written (the shim runs inside a rolled-back transaction).
// Env: DATABASE_URL, COMPANY_ID, ACCOUNT_CODE, MONTH (YYYY-MM).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { loadMonthForLock } from '../src/scm/routes/accounting-bank-months.ts';

const CO = Number(process.env.COMPANY_ID);
const ACCT = String(process.env.ACCOUNT_CODE ?? '').trim();
const MONTH = String(process.env.MONTH ?? '').trim();
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '—' : (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
class Rollback extends Error {}
try {
  await sql.begin(async (tx) => {
    const [lock] = await tx`SELECT * FROM scm.acc_bank_month_locks WHERE company_id = ${CO} AND account_code = ${ACCT} AND period_month = ${MONTH + '-01'}::date ORDER BY locked_at DESC LIMIT 1`;
    out(`lock: ${lock ? `closed ${lock.locked_at} by ${lock.locked_by}${lock.released_at ? ` RELEASED ${lock.released_at}` : ''} — statement ${rm(lock.closing_statement_sen)} ledger ${rm(lock.closing_ledger_sen)} difference ${rm(lock.difference_sen)}` : 'none'}`);
    const sb = pgrestShim(tx, 'scm');
    const st = await loadMonthForLock(sb, CO, ACCT, MONTH);
    if (!st.ok) throw new Error(st.reason);
    const r = st.reconciliation;
    out(`today: ${JSON.stringify({ closingStatementSen: r.closingStatementSen, closingLedgerSen: r.closingLedgerSen, computedClosingSen: r.computedClosingSen, differenceSen: r.differenceSen, unexplainedSen: r.unexplainedSen, tallies: r.tallies, consistent: r.consistent, open: st.openCount, lines: st.lineCount, statements: st.statementCount, complete: st.assembly.complete })}`);
    if (sb.__gaps.length) out(`shim gaps: ${sb.__gaps.join(' | ')}`);
    if (lock) {
      const since = await tx`
        SELECT j.je_no, j.entry_date, j.created_at, j.source_type, j.source_doc_no, j.reversed, l.debit_sen, l.credit_sen
          FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
         WHERE j.company_id = ${CO} AND l.account_code = ${ACCT}
           AND j.entry_date >= ${MONTH + '-01'}::date AND j.entry_date < (${MONTH + '-01'}::date + interval '1 month')
           AND j.created_at > ${lock.locked_at}::timestamptz
         ORDER BY j.created_at`;
      let net = 0;
      for (const x of since) {
        const n = Number(x.debit_sen) - Number(x.credit_sen);
        net += n;
        out(`  after-lock ${x.je_no} dated ${String(x.entry_date).slice(0, 10)} written ${String(x.created_at).slice(0, 16)} ${x.source_type} ${x.source_doc_no} ${n >= 0 ? 'Dr' : 'Cr'} ${rm(Math.abs(n))}${x.reversed ? ' (reversed)' : ''}`);
      }
      out(`${since.length} line(s) written into ${ACCT} ${MONTH} after it was closed, net ${rm(net)}`);
      for (const x of since.filter((y) => ['SOPAY', 'SIPAY'].includes(String(y.source_type)))) {
        const [p] = await tx`SELECT so_doc_no, method, online_type, amount_sen, approval_code, created_at FROM scm.mfg_sales_order_payments WHERE id::text = ${String(x.source_doc_no)}`;
        if (p) out(`    ${x.je_no} = payment on ${p.so_doc_no} ${p.method}${p.online_type ? `/${p.online_type}` : ''} RM ${rm(p.amount_sen)} ref ${p.approval_code ?? '—'} keyed ${String(p.created_at).slice(0, 10)}`);
      }
    }
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; }
} finally { await sql.end(); }
