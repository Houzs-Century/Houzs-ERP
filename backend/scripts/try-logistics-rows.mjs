#!/usr/bin/env node
// try-logistics-rows.mjs — PRODUCTION, ROLLED BACK. The same digest of the Logistics
// P&L and the Logistics cost report, for the months in MONTHS, from whatever code
// this branch carries: on acc/logistics-pnl-check the name rules (BEFORE), on
// acc/coa-logistics-row-check the Chart of Accounts' Logistics column with
// migration 20261029T2200_acc_account_logistics_row.sql run inside the transaction
// first (WITH_MIGRATION=1, AFTER). The two outputs must agree line for line.
// Also (AFTER): what the migration wrote, and any Other Debtor line on 590-0000.
// Nothing is kept. Env: DATABASE_URL, COMPANY_ID (1), MONTHS, WITH_MIGRATION (0).
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { logisticsPnlHandler } from '../src/scm/routes/acc-logistics-pnl.ts';
import { logisticsCostHandler } from '../src/scm/routes/acc-logistics.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const MONTHS = String(process.env.MONTHS || '2026-09,2026-10').split(',').map((s) => s.trim()).filter(Boolean);
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '—' : (Number(sen) / 100).toFixed(2));
const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    if (process.env.WITH_MIGRATION === '1') {
      await tx.unsafe(readFileSync(new URL('../src/db/migrations-pg/20261029T2200_acc_account_logistics_row.sql', import.meta.url), 'utf8'));
      out('AFTER — migration applied inside the transaction');
      for (const r of await tx`
        SELECT logistics_row, company_id, count(*)::int AS n, string_agg(account_code, ' ' ORDER BY account_code) AS codes
          FROM scm.accounts WHERE logistics_row IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`) out(`  wrote ${r.logistics_row} co${r.company_id} (${r.n}): ${r.codes}`);
      const [odb] = await tx`SELECT count(*)::int AS n FROM scm.acc_debtor_bill_lines WHERE credit_account_code = '590-0000'`;
      out(`  Other Debtor lines on 590-0000, any company, any time: ${odb.n}`);
    } else out('BEFORE — the code on this branch, nothing applied');
    const sb = pgrestShim(tx, 'scm');
    for (const m of MONTHS) {
      const from = `${m}-01`;
      const to = lastDay(m);
      const c = {
        env: { DB: d1Compat(() => tx) },
        req: { query: (k) => ({ from, to })[k], path: '/api/scm/acc-events/logistics' },
        get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'allowedCompanyIds' ? [CO] : k === 'houzsUser' ? { name: 'rehearsal' } : undefined),
        json: (body, status = 200) => ({ body, status }),
      };
      const pnl = await logisticsPnlHandler(c);
      const cost = await logisticsCostHandler(c);
      if (sb.__gaps.length > 0) throw new Error(`shim gaps: ${sb.__gaps.join(' | ')}`);
      if (pnl.status !== 200) throw new Error(`pnl status ${pnl.status}: ${JSON.stringify(pnl.body)}`);
      if (cost.status !== 200) throw new Error(`cost status ${cost.status}: ${JSON.stringify(cost.body)}`);
      const p = pnl.body;
      out(`== ${m} P&L`);
      for (const r of p.rows) out(`  ${r.label} | ${rm(r.sen.PG)} | ${rm(r.sen.KL)} | ${rm(r.sen.EM)} | ${rm(r.sen.SG)} | ${rm(r.totalSen)}`);
      out(`  per trip ${rm(p.inHousePerTripSen)} over ${p.ownTrips}`);
      for (const l of p.income) out(`  income ${l.billNo} ${l.month} ${l.row}/${l.region} ${l.by} ${rm(l.amountSen)}`);
      for (const s of p.spreads) out(`  spread ${s.day} ${s.accountCode} ${rm(s.amountSen)} / ${s.months} → ${rm(s.inRangeSen)}`);
      const r = cost.body;
      out(`== ${m} cost report`);
      out(`  totals dos ${r.totals.dos} own ${rm(r.totals.ownSen)} 3pl ${rm(r.totals.threeplSen)} total ${rm(r.totals.totalSen)}`);
      for (const x of r.months) out(`  month ${x.month} own ${rm(x.ownCostSen)} trips ${x.trips} per trip ${rm(x.perTripSen)} on ${x.accounts.map((a) => `${a.code}=${rm(a.sen)}`).join(' ')}`);
      for (const g of r.regions) out(`  region ${g.code} dos ${g.dos} own ${rm(g.ownSen)} 3pl ${rm(g.threeplSen)}`);
      out(`  own trips ${r.trips.filter((t) => t.kind === 'own').map((t) => `${t.day}:${rm(t.amountSen)}`).join(' ')}`);
    }
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) out('ROLLED BACK — nothing was kept.');
  else { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; }
} finally {
  await sql.end();
}
