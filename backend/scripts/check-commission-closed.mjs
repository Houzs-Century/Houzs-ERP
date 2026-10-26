#!/usr/bin/env node
// check-commission-closed.mjs — READ ONLY. After closing a month of Event
// Commission: the closed month read whole (served as closed, who and when) and
// the next month (what it carries for the closed one), both bases, through the
// app's own handler. Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1),
// MONTH (default 2026-09).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const MONTH = process.env.MONTH || '2026-09';
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const next = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const sb = pgrestShim(sql, 'scm');
    const ctx = (query) => ({
      env: { DB: d1Compat(() => sql) },
      req: { query: (k) => query[k], json: async () => ({}), path: '/api/scm/acc-events/commission' },
      get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : undefined),
      json: (b, status = 200) => ({ body: b, status }),
    });
    for (const basis of ['fair', 'so_date']) {
      const m = await eventCommissionHandler(ctx({ from: `${MONTH}-01`, to: lastDay(MONTH), basis }));
      out(`${MONTH} by ${basis}: HTTP ${m.status} closed ${JSON.stringify(m.body.closed ?? null)} total RM ${rm(m.body.totals?.totalSen)} closes ${JSON.stringify(m.body.closes)}`);
      const t = Date.now();
      const n = await eventCommissionHandler(ctx({ from: `${next(MONTH)}-01`, to: lastDay(next(MONTH)), basis }));
      out(`${next(MONTH)} by ${basis}: HTTP ${n.status} in ${Date.now() - t} ms, total RM ${rm(n.body.totals?.totalSen)} = in range ${rm(n.body.totals?.payableSen)} + earlier ${rm(n.body.totals?.adjustmentsSen)} + ${MONTH} adjustments ${rm(n.body.totals?.monthAdjustmentsSen)} (${n.body.monthAdjustments?.length ?? 0} orders)`);
    }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
