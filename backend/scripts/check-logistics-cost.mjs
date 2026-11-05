#!/usr/bin/env node
// check-logistics-cost.mjs — PRODUCTION CHECK, READ ONLY, ROLLED BACK (not for merge).
// The migration 20261105T1200_acc_logistics_fair_income.sql inside one transaction,
// then the Logistics cost handler (GET /acc-events/logistics/pnl) for each month
// in MONTHS through lib/pgrest-shim.mjs and d1Compat on the same transaction.
// Prints the P&L, By region & trip (lorries, carriers, no DO) with its Difference
// against the P&L's TOTAL EXPENSE, and Setup & Dismantle per fair with its
// Difference against the fairs' own books; then ROLLS BACK — nothing stays.
// Env: DATABASE_URL, COMPANY_ID (1), MONTHS (2026-10).
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { logisticsPnlHandler } from '../src/scm/routes/acc-logistics-pnl.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const MONTHS = String(process.env.MONTHS || '2026-10').split(',').map((s) => s.trim()).filter(Boolean);
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '-' : (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const R = (x) => `PG ${rm(x.PG)} | KL ${rm(x.KL)} | EM ${rm(x.EM)} | SG ${rm(x.SG)}`;
const sumR = (x) => x.PG + x.KL + x.EM + x.SG;
const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(new URL('../src/db/migrations-pg/20261105T1200_acc_logistics_fair_income.sql', import.meta.url), 'utf8'));
    out('migration applied inside the transaction');
    const sb = pgrestShim(tx, 'scm');
    for (const m of MONTHS) {
      const from = `${m}-01`;
      const to = lastDay(m);
      const c = {
        env: { DB: d1Compat(() => tx) },
        req: { query: (k) => ({ from, to })[k], path: '/api/scm/acc-events/logistics/pnl' },
        get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'allowedCompanyIds' ? [CO] : k === 'houzsUser' ? { name: 'check' } : undefined),
        json: (body, status = 200) => ({ body, status }),
      };
      const res = await logisticsPnlHandler(c);
      if (sb.__gaps.length > 0) throw new Error(`shim gaps: ${sb.__gaps.join(' | ')}`);
      if (res.status !== 200) throw new Error(`status ${res.status}: ${JSON.stringify(res.body)}`);
      const p = res.body;
      out(`== ${m} (company ${CO}) DOs ${JSON.stringify(p.dos)}; trips problem: ${p.tripsProblem ?? 'none'}; fairs problem: ${p.fairsProblem ?? 'none'}`);
      out('-- P&L');
      for (const r of p.rows) out(`${r.label} | ${R(r.sen)} | TOTAL ${rm(r.totalSen)}`);
      const pm = p.perMonth[0];
      const total = (k) => pm.rows.find((r) => r.key === k)?.totalSen ?? 0;
      out('-- By region & trip');
      out(`DOs ${R(pm.cost.dos)} ; goods ${R(pm.cost.goodsSen)}`);
      out(`our lorries: ${pm.cost.ownTrips} trips; in-house ${rm(pm.cost.inHouseSen)}; per trip ${pm.cost.ownTrips ? rm(Math.round(pm.cost.inHouseSen / pm.cost.ownTrips)) : '-'}; no-trip ${rm(pm.cost.inHouseNoTripSen)}`);
      for (const l of pm.cost.lorries) out(`  lorry ${l.plate} ${l.trips} trips ${l.dos} DOs | ${R(l.sen)} | ${rm(sumR(l.sen))}`);
      for (const x of pm.cost.carriers) out(`  3PL ${x.name} ${x.bills} bills ${x.lines} lines ${x.dos} DOs | ${R(x.sen)} | ${rm(sumR(x.sen))}`);
      out(`  3PL on no DO yet: ${pm.cost.threeplNoDo.lines} lines ${rm(pm.cost.threeplNoDo.sen)}`);
      out(`  DOs with nobody: ${R(pm.cost.noDeliverer)}`);
      out(`TOTAL DELIVERY COST ${rm(pm.costTotalSen)} | P&L TOTAL EXPENSE ${rm(total('total_expense'))} | DIFFERENCE ${rm(pm.costTotalSen - total('total_expense'))}`);
      out('-- Setup & Dismantle');
      let cost = 0; let books = 0;
      for (const f of pm.fairs) {
        const c2 = f.chargeSen + f.setupSen + f.dismantleSen + f.transportSen;
        cost += c2; books += f.booksSen;
        out(`  ${f.region} ${f.name} (${f.startDate}..${f.endDate}) sales ${rm(f.salesSen)} income ${rm(f.incomeSen)} | charge ${f.chargeTrips} trips ${rm(f.chargeSen)} setup ${rm(f.setupSen)} dismantle ${rm(f.dismantleSen)} transport ${rm(f.transportSen)} = ${rm(c2)} | books ${rm(f.booksSen)} | diff ${rm(c2 - f.booksSen)} | ${f.who}`);
      }
      out(`  no fair picked: ${pm.noFair.lines} lines ${rm(pm.noFair.sen)}`);
      out(`FAIRS ${pm.fairs.length} | COST ${rm(cost)} | BOOKS ${rm(books)} | DIFFERENCE ${rm(cost - books)}`);
      out(`sd_income (P&L) ${rm(total('sd_income'))} | fair_income ${rm(total('fair_income'))}`);
    }
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) out('ROLLED BACK — nothing was kept.');
  else { out(`FAILED: ${e?.stack ?? e}`); process.exitCode = 1; }
} finally {
  await sql.end();
}
