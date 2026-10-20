#!/usr/bin/env node
// check-event-commission.mjs — READ-ONLY. Runs the Event Commission report's own
// handler (scm/routes/acc-event-commission.ts — the rules in
// scm/lib/event-commission.ts) against production, over the same transport the
// costing repairs use (scripts/lib/pgrest-shim.mjs for the scm client, the
// D1-compat shim for env.DB), so the figures are the page's, not a re-telling.
//
// Before go-live scm.so_total_changes does not exist yet; the script then reads
// it as empty (no upsales / drops recorded — true until go-live anyway).
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), RANGES (default
// "2026-09-01..2026-09-30;2026-10-01..2026-10-20").
//   npx tsx scripts/check-event-commission.mjs

import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const RANGES = String(process.env.RANGES || '2026-09-01..2026-09-30;2026-10-01..2026-10-20')
  .split(';').map((r) => r.split('..')).filter((r) => r.length === 2);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

try {
  const [{ exists }] = await sql`SELECT to_regclass('scm.so_total_changes') IS NOT NULL AS exists`;
  const real = pgrestShim(sql, 'scm');
  /* A chain that answers "no rows" to anything — the table before go-live. */
  const empty = () => new Proxy({}, {
    get: (_t, k) => (k === 'then' ? (res) => res({ data: [], error: null }) : () => empty()),
  });
  const sb = { ...real, from: (t) => (t === 'so_total_changes' && !exists ? empty() : real.from(t)) };
  console.log(`company ${CO}; scm.so_total_changes ${exists ? 'exists' : 'not yet created (read as empty)'}`);

  for (const [from, to] of RANGES) {
    const c = {
      env: { DB: d1Compat(() => sql) },
      req: { query: (k) => ({ from, to })[k], path: '/api/scm/acc-events/commission' },
      get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : undefined),
      json: (body, status = 200) => ({ body, status }),
    };
    const res = await eventCommissionHandler(c);
    if (res.status !== 200) { console.log(`\n${from} → ${to}: HTTP ${res.status}`, JSON.stringify(res.body).slice(0, 400)); continue; }
    const r = res.body;
    const sos = r.fairs.flatMap((f) => f.sos);
    const reached = sos.filter((s) => s.reachedOn);
    const estimate = r.fairs.reduce((s, f) => s + (Number(f.estimateRm) || 0), 0);
    console.log(`\n${from} → ${to}: fairs ${r.fairs.length}, orders ${sos.length} (30% reached ${reached.length}, not yet ${sos.length - reached.length})`);
    console.log(`  commission — fairs in range RM ${rm(r.totals.payableSen)} · earlier fairs RM ${rm(r.totals.adjustmentsSen)} (${r.adjustments.length} lines) · total RM ${rm(r.totals.totalSen)}`);
    console.log(`  event pages' estimate (Total Sales × %) RM ${estimate.toLocaleString('en-MY', { maximumFractionDigits: 0 })}`);
    const kinds = {};
    for (const a of r.adjustments) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
    if (r.adjustments.length) console.log(`  earlier-fair lines: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    const noRate = r.fairs.filter((f) => f.ratePct == null);
    if (noRate.length) console.log(`  no rate card: ${noRate.map((f) => `${f.name} (${f.brand ?? '—'})`).join('; ')}`);
    for (const f of [...r.fairs].sort((a, b) => b.payableSen - a.payableSen).slice(0, 5)) {
      const fs = f.sos;
      console.log(`  · ${f.name} (${f.startDate}, ${f.ratePct ?? '—'}%): ${fs.length} orders, ${fs.filter((s) => s.reachedOn).length} at 30% — commission RM ${rm(f.payableSen)} vs estimate RM ${Number(f.estimateRm ?? 0).toLocaleString('en-MY', { maximumFractionDigits: 0 })} (Total Sales RM ${Number(f.totalSalesRm ?? 0).toLocaleString('en-MY', { maximumFractionDigits: 0 })})`);
    }
  }
} finally {
  await sql.end();
}
