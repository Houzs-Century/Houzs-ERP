#!/usr/bin/env node
// check-logistics-report.mjs — READ ONLY, ROLLED BACK. The Logistics cost report's
// own handler (src/scm/routes/acc-logistics.ts) over PRODUCTION through
// lib/pgrest-shim.mjs, inside one transaction: migration 20261029T1600 first (the
// settings table the report reads — not yet live), then GET /acc-events/logistics
// for FROM..TO. Prints the totals, the months, the regions, a trip summary and what
// was not counted, then ROLLS BACK — nothing stays. The fairs' books need the event
// connection, which a script has not: Setup & Dismantle reports that, by design.
// Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-10-01), TO (2026-10-31).
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { logisticsCostHandler } from '../src/scm/routes/acc-logistics.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-10-01');
const TO = String(process.env.TO || '2026-10-31');
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const out = (s) => console.log(`ROW|${s}`);
class Rollback extends Error {}
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(new URL('../src/db/migrations-pg/20261029T1600_acc_logistics_settings.sql', import.meta.url), 'utf8'));
    const sb = pgrestShim(tx, 'scm');
    const c = {
      env: {},
      req: { query: (k) => ({ from: FROM, to: TO })[k], path: '/api/scm/acc-events/logistics' },
      get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'allowedCompanyIds' ? [CO] : k === 'houzsUser' ? { name: 'check' } : undefined),
      json: (body, status = 200) => ({ body, status }),
    };
    const res = await logisticsCostHandler(c);
    if (sb.__gaps.length > 0) throw new Error(`shim gaps: ${sb.__gaps.join(' | ')}`);
    if (res.status !== 200) throw new Error(`status ${res.status}: ${JSON.stringify(res.body)}`);
    const r = res.body;
    out(`company ${CO} ${r.from}..${r.to} — accounts ${r.ownCostDefault ? '(default)' : '(ticked)'}: ${r.ownCostAccounts.join(', ')}`);
    const t = r.totals;
    out(`totals: ${t.dos} DOs, goods ${rm(t.valueSen)}, our lorries ${rm(t.ownSen)}, 3PL ${rm(t.threeplSen)}, total ${rm(t.totalSen)}`);
    for (const m of r.months) out(`month ${m.month}: cost ${rm(m.ownCostSen)}, trips ${m.trips}, per trip ${m.perTripSen == null ? '-' : rm(m.perTripSen)} | ${m.accounts.map((a) => `${a.code} ${rm(a.sen)}`).join(', ')}`);
    for (const g of r.regions) out(`region ${g.name} [${g.covers}]: ${g.dos} DOs, goods ${rm(g.valueSen)}, ours ${rm(g.ownSen)}, 3PL ${rm(g.threeplSen)}, total ${rm(g.totalSen)}`);
    const own = r.trips.filter((x) => x.kind === 'own');
    const pl = r.trips.filter((x) => x.kind === '3pl');
    out(`trips: ${own.length} of ours (${[...new Set(own.map((x) => x.who))].join(', ')}), ${pl.length} 3PL runs ${rm(pl.reduce((s, x) => s + (x.amountSen ?? 0), 0))}`);
    for (const x of own.slice(0, 8)) out(`  own ${x.day} ${x.who}: ${x.dos} DOs ${x.regions.join('/')} ${x.amountSen == null ? '-' : rm(x.amountSen)}`);
    out(`gaps: ${JSON.stringify(r.gaps)}`);
    out(`events: ${r.eventsProblem ?? `${r.events.length} fairs`}`);
    throw new Rollback();
  });
} catch (e) {
  if (e instanceof Rollback) out('ROLLED BACK — nothing was kept.');
  else { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; }
} finally {
  await sql.end();
}
