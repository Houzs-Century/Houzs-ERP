#!/usr/bin/env node
// check-bank-month-lockable.mjs — READ ONLY. Would the Lock button close this bank
// month right now? Runs the lock route's own reading (loadMonthForLock → mayLockMonth)
// for every company that holds statements on the account, and prints the month's
// opening (and where it came from), closing, gaps, and the verdict. Writes nothing.
// Env: DATABASE_URL, ACCOUNT_CODE, MONTH (YYYY-MM).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { loadMonthForLock } from '../src/scm/routes/accounting-bank-months.ts';
import { mayLockMonth } from '../src/acc/bank-lock.ts';

const CODE = String(process.env.ACCOUNT_CODE ?? '').trim();
const MONTH = String(process.env.MONTH ?? '').trim();
if (!CODE || !/^\d{4}-\d{2}$/.test(MONTH)) { console.error('Refused: ACCOUNT_CODE and MONTH are required.'); process.exit(2); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '—' : `RM ${(Number(sen) / 100).toFixed(2)}`);
try {
  const cos = await sql`SELECT DISTINCT company_id FROM scm.acc_bank_statements WHERE account_code = ${CODE} ORDER BY company_id`;
  const sb = pgrestShim(sql, 'scm');
  for (const { company_id: co } of cos) {
    const st = await loadMonthForLock(sb, Number(co), CODE, MONTH);
    if (!st.ok) { out(`company ${co}: FAILED ${st.reason}`); continue; }
    const a = st.assembly; const r = st.reconciliation;
    out(`company ${co} ${CODE} ${MONTH}: opening ${rm(a.statementOpeningSen)} (${JSON.stringify(a.openingFrom)}) · closing ${rm(a.statementClosingSen)} (${JSON.stringify(a.closingFrom)})`);
    out(`  complete=${a.complete} gaps=${JSON.stringify(a.gaps)} · statements ${st.statementCount} lines ${st.lineCount} open ${st.openCount}`);
    out(`  reconciliation: tallies=${r.tallies} consistent=${r.consistent} computed ${rm(r.computedClosingSen)} statement ${rm(r.closingStatementSen)} unexplained ${rm(r.unexplainedSen)}`);
    const v = mayLockMonth({
      accountCode: CODE, month: MONTH, openCount: st.openCount, lineCount: st.lineCount, statementCount: st.statementCount,
      computedClosingSen: r.computedClosingSen, closingStatementSen: r.closingStatementSen, unexplainedSen: r.unexplainedSen,
      tallies: r.tallies, consistent: r.consistent, complete: a.complete,
    });
    out(`  LOCK: ${v.ok ? 'would close' : `refused — ${v.error}: ${v.message}`}`);
  }
} catch (e) {
  out(`FAILED: ${e?.stack ?? e?.message ?? e}`); process.exitCode = 1;
} finally {
  await sql.end();
}
