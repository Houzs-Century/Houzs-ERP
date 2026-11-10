#!/usr/bin/env node
// check-sarah-listed.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// After #5606 (a fee booked on a card payout's advice day counts as paid): is 2990-SO-2606-005
// still in Payments not matched yet, read through the shipped handler on production data?
// Prints document numbers, states and counts only — this repository's Actions logs are public.
// Env: DATABASE_URL, COMPANY_ID (default 2), SO (default 2990-SO-2606-005), FROM (default 2026-05-01).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { unmatchedPaymentsHandler } from '../src/scm/routes/accounting-unmatched-payments.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 2);
const SO = String(process.env.SO || '2990-SO-2606-005');
const FROM = String(process.env.FROM || '2026-05-01');
const TO = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
      c.set('houzsUser', { name: 'read-only check', permissions_set: ['*'] });
      await next();
    });
    app.get('/accounting/unmatched-payments', unmatchedPaymentsHandler);
    const res = await app.request(`/accounting/unmatched-payments?from=${FROM}&to=${TO}`);
    if (res.status !== 200) { row('REFUSED', res.status); return; }
    const rows = (await res.json()).rows ?? [];
    const mine = rows.filter((r) => r.docNo === SO);
    row('LISTED', SO, mine.length > 0 ? 'yes' : 'no', mine.map((r) => r.state).join(',') || '—');
    const notInBank = rows.filter((r) => r.state === 'CARD_NOT_IN_BANK');
    row('CARD_NOT_IN_BANK', `co${CO}`, `${FROM}..${TO}`, `rows ${notInBank.length}`,
      `paid in part ${notInBank.filter((r) => r.report && r.report.bankShare > 0 && r.report.bankShare < 1).length}`);
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
