#!/usr/bin/env node
// sweep-bank-months.mjs — READ ONLY. Every month of every reconciled bank account
// of every company, read the way the Lock button reads it (accounting-bank-months.ts
// loadMonthForLock) by whatever code this branch carries: does it tally, and by
// how much is it out. Run on main and on a fix branch and compare. Nothing is
// written (inside a rolled-back transaction). Env: DATABASE_URL.
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { loadMonthForLock } from '../src/scm/routes/accounting-bank-months.ts';

const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '—' : (Number(sen) / 100).toFixed(2));
class Rollback extends Error {}
try {
  await sql.begin(async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    const spans = await tx`SELECT company_id, account_code, min(period_from)::text AS f, max(period_to)::text AS t FROM scm.acc_bank_statements GROUP BY 1, 2 ORDER BY 1, 2`;
    const locks = await tx`SELECT company_id, account_code, to_char(period_month, 'YYYY-MM') AS m FROM scm.acc_bank_month_locks WHERE released_at IS NULL`;
    const locked = new Set(locks.map((l) => `${l.company_id}|${l.account_code}|${l.m}`));
    for (const s of spans) {
      for (let m = s.f.slice(0, 7); m <= s.t.slice(0, 7);) {
        const st = await loadMonthForLock(sb, Number(s.company_id), s.account_code, m);
        const tag = locked.has(`${s.company_id}|${s.account_code}|${m}`) ? 'LOCKED' : 'open';
        if (!st.ok) out(`co${s.company_id} ${s.account_code} ${m} ${tag} — ${st.reason}`);
        else out(`co${s.company_id} ${s.account_code} ${m} ${tag} tallies=${st.reconciliation.tallies} unexplained=${rm(st.reconciliation.unexplainedSen)} carried=${st.reconciliation.carried.count}/${rm(st.reconciliation.carried.sen)} open=${st.openCount}`);
        const [y, mo] = m.split('-').map(Number);
        m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
      }
    }
    if (sb.__gaps.length) out(`shim gaps: ${sb.__gaps.join(' | ')}`);
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; }
} finally { await sql.end(); }
