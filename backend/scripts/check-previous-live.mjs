#!/usr/bin/env node
// check-previous-live.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// After #5664: the previous-record table on production — there, empty, the service
// role may read and write it, PostgREST is told of new tables (its DDL watch) — and
// the lists that now read it answer as before, through the shipped handlers.
// Prints counts and yes/no only (public logs).
// Env: DATABASE_URL, COMPANY_IDS (default 1,2).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { previousPaymentsList } from '../src/scm/routes/accounting-previous-payments.ts';
import { unmatchedPaymentsHandler } from '../src/scm/routes/accounting-unmatched-payments.ts';
import { settlementWatchlist } from '../src/scm/routes/accounting-settlement.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const yn = (b) => (b ? 'yes' : 'no');

try {
  await sql.begin('read only', async (tx) => {
    const [t] = await tx`SELECT to_regclass('scm.acc_previous_payment_records') IS NOT NULL AS there`;
    row('TABLE', `there ${yn(t.there)}`);
    if (!t.there) return;
    const [n] = await tx`SELECT count(*)::int AS n FROM scm.acc_previous_payment_records`;
    const [p] = await tx`SELECT has_table_privilege('service_role', 'scm.acc_previous_payment_records', 'SELECT') AS r,
                                has_table_privilege('service_role', 'scm.acc_previous_payment_records', 'INSERT') AS i,
                                has_table_privilege('service_role', 'scm.acc_previous_payment_records', 'DELETE') AS d`;
    const watch = await tx`SELECT evtname FROM pg_event_trigger WHERE evtname ILIKE '%pgrst%'`;
    row('TABLE', `rows ${n.n}`, `service role read ${yn(p.r)} insert ${yn(p.i)} delete ${yn(p.d)}`, `PostgREST DDL watch ${watch.length > 0 ? watch.map((w) => w.evtname).join(',') : 'none'}`);

    const sb = pgrestShim(tx, 'scm');
    for (const CO of COS) {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
        c.set('houzsUser', { name: 'read-only check', permissions_set: ['*', 'scm.payment_voucher.post'] });
        await next();
      });
      app.get('/prev', previousPaymentsList);
      app.get('/u', unmatchedPaymentsHandler);
      app.get('/w', settlementWatchlist);
      const prev = await app.request('/prev');
      const u = await app.request('/u');
      const TO = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const FROM = new Date(Date.parse(`${TO}T00:00:00Z`) - 180 * 86_400_000).toISOString().slice(0, 10);
      const u2 = await app.request(`/u?from=${FROM}&to=${TO}`);
      const u2b = await u2.json();
      row('WINDOW', `co${CO}`, `default window rows ${'?'}`, `explicit ${FROM}..${TO} ${u2.status} rows ${(u2b.rows ?? []).length}`, `keys ${Object.keys(u2b).join(',')}`);
      const w = await app.request('/w');
      const pb = await prev.json(); const ub = await u.json(); const wb = await w.json();
      row('LISTS', `co${CO}`, `previous records ${prev.status} rows ${(pb.rows ?? []).length}`, `default keys ${Object.keys(ub).join(',')} ${JSON.stringify(ub).slice(0, 120).replace(/[0-9]/g, '#')}`,
        `payments not matched ${u.status} rows ${(ub.rows ?? []).length}`, `watch list ${w.status} rows ${(wb.recordedNotArrived ?? []).length}`);
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
