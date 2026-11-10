#!/usr/bin/env node
// check-unm-once.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// After #5608 (Payments not matched yet lists each thing once): read the Payments and Bank money
// in lists through the shipped handlers on production data — how many payments, by stage, none
// merchant-matched, and how many transfers a bank line on Bank money in is offered.
// Prints counts only — this repository's Actions logs are public.
// Env: DATABASE_URL, COMPANY_IDS (default 1,2), DAYS (default 180).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { unmatchedPaymentsHandler, unmatchedBankLinesHandler } from '../src/scm/routes/accounting-unmatched-payments.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const TO = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const FROM = new Date(Date.parse(`${TO}T00:00:00Z`) - Number(process.env.DAYS || 180) * 86_400_000).toISOString().slice(0, 10);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    for (const CO of COS) {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
        c.set('houzsUser', { name: 'read-only check', permissions_set: ['*'] });
        await next();
      });
      app.get('/p', unmatchedPaymentsHandler);
      app.get('/b', unmatchedBankLinesHandler);
      const pay = await app.request(`/p?from=${FROM}&to=${TO}`);
      const bank = await app.request(`/b?from=${FROM}&to=${TO}`);
      if (pay.status !== 200 || bank.status !== 200) { row('REFUSED', `co${CO}`, pay.status, bank.status); continue; }
      const rows = (await pay.json()).rows ?? [];
      const lines = (await bank.json()).rows ?? [];
      const byState = {};
      for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
      const offered = new Set(lines.flatMap((l) => (l.entries ?? []).map((e) => e.jeNo)));
      const transfers = rows.filter((r) => r.kind === 'transfer');
      row('PAYMENTS', `co${CO}`, `${FROM}..${TO}`, `rows ${rows.length}`,
        Object.entries(byState).sort().map(([k, n]) => `${k} ${n}`).join(', '),
        `merchant matched listed ${rows.filter((r) => r.state === 'CARD_NOT_IN_BANK').length}`);
      row('TRANSFERS', `co${CO}`, `rows ${transfers.length}`, `carry their entry ${transfers.filter((r) => r.jeNo).length}`,
        `a bank line on Bank money in is offered their entry ${transfers.filter((r) => r.jeNo && offered.has(r.jeNo)).length}`);
      row('BANK_MONEY_IN', `co${CO}`, `lines ${lines.length}`);
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
