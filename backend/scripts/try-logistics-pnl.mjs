#!/usr/bin/env node
// try-logistics-pnl.mjs — PRODUCTION REHEARSAL, ROLLED BACK. Migration
// 20261029T2000_acc_logistics_pnl.sql run inside one transaction, then the Logistics
// P&L's own handler (src/scm/routes/acc-logistics-pnl.ts, GET /acc-events/logistics/pnl)
// for each month in MONTHS through lib/pgrest-shim.mjs and d1Compat on the same
// transaction. Prints every row by region, the bill lines counted as transport
// income, the setup / dismantle trips by area, the spread bills; then ROLLS BACK —
// nothing stays. Env: DATABASE_URL, COMPANY_ID (1), MONTHS (2026-09,2026-10).
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { logisticsPnlHandler } from '../src/scm/routes/acc-logistics-pnl.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const MONTHS = String(process.env.MONTHS || '2026-09,2026-10').split(',').map((s) => s.trim()).filter(Boolean);
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '—' : (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(new URL('../src/db/migrations-pg/20261029T2000_acc_logistics_pnl.sql', import.meta.url), 'utf8'));
    out('migration applied inside the transaction');
    const sb = pgrestShim(tx, 'scm');
    for (const m of MONTHS) {
      const from = `${m}-01`;
      const to = lastDay(m);
      const c = {
        env: { DB: d1Compat(() => tx) },
        req: { query: (k) => ({ from, to })[k], path: '/api/scm/acc-events/logistics/pnl' },
        get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'allowedCompanyIds' ? [CO] : k === 'houzsUser' ? { name: 'rehearsal' } : undefined),
        json: (body, status = 200) => ({ body, status }),
      };
      const res = await logisticsPnlHandler(c);
      if (sb.__gaps.length > 0) throw new Error(`shim gaps: ${sb.__gaps.join(' | ')}`);
      if (res.status !== 200) throw new Error(`status ${res.status}: ${JSON.stringify(res.body)}`);
      const p = res.body;
      out(`== ${m} (company ${CO}) — DOs PG ${p.dos.PG} KL ${p.dos.KL} EM ${p.dos.EM} SG ${p.dos.SG} = ${p.dos.total}; trips problem: ${p.tripsProblem ?? 'none'}`);
      out('row | Penang | KL | SBH & SWK | SGD | TOTAL');
      for (const r of p.rows) out(`${r.label} | ${rm(r.sen.PG)} | ${rm(r.sen.KL)} | ${rm(r.sen.EM)} | ${rm(r.sen.SG)} | ${rm(r.totalSen)}`);
      out(`own trips ${p.ownTrips}, in-house per trip ${rm(p.inHousePerTripSen)}`);
      for (const l of p.income) out(`  income ${l.billNo} ${l.billDate} for ${l.month} ${l.debtorName} → ${l.row}/${l.region} (${l.by}) ${l.description ?? ''} ${rm(l.amountSen)}`);
      const byArea = new Map();
      for (const t of p.trips) {
        const k = `${t.areaLabel}`;
        const a = byArea.get(k) ?? { trips: 0, ours: 0, outsourced: 0, sen: 0 };
        a.trips += 1; if (t.inHouse) a.ours += 1; if (t.outsourced) a.outsourced += 1; a.sen += t.amountSen;
        byArea.set(k, a);
      }
      for (const [k, a] of byArea) out(`  trips ${k}: ${a.trips} (ours ${a.ours}, outsourced ${a.outsourced}) income ${rm(a.sen)}`);
      for (const s of p.spreads) out(`  spread ${s.day} ${s.accountCode} ${s.notes ?? ''} ${rm(s.amountSen)} / ${s.months} → ${rm(s.inRangeSen)}`);
    }
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) out('ROLLED BACK — nothing was kept.');
  else { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; }
} finally {
  await sql.end();
}
