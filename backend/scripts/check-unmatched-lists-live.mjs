#!/usr/bin/env node
// check-unmatched-lists-live.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// After PR "Payments not matched yet — three lists" (owner 2026-11-10 → 做): the two server
// lists through their REAL handlers, and the merchant report lines the page reads, counted:
//  REPORT_LINES  open merchant report lines dated in the window (the page's first list);
//  PAYMENTS      GET /accounting/unmatched-payments by state; CARD_NOT_IN_BANK split by why;
//  BANK          GET /accounting/unmatched-bank-lines by what; transfers by entries found.
// Env: DATABASE_URL, COMPANY_IDS (default "1,2"), FROM (default 180 days ago), TO (default today MYT).
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { unmatchedPaymentsHandler, unmatchedBankLinesHandler } from '../src/scm/routes/accounting-unmatched-payments.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const TO = String(process.env.TO || today);
const FROM = String(process.env.FROM || new Date(Date.parse(`${TO}T00:00:00Z`) - 180 * 86_400_000).toISOString().slice(0, 10));
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const tally = (rows, keyOf, senOf) => {
  const t = new Map();
  for (const r of rows) { const k = keyOf(r); const x = t.get(k) ?? { n: 0, sen: 0 }; x.n += 1; x.sen += Number(senOf(r) ?? 0); t.set(k, x); }
  return [...t].sort();
};

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    for (const CO of COS) {
      console.log(`\n=== company ${CO}, ${FROM}..${TO}`);

      for (const g of await tx`
        SELECT b.acquirer_code AS acq, count(*)::int AS n, coalesce(sum(r.gross_sen), 0)::bigint AS sen,
               count(*) FILTER (WHERE r.bucket = 'UNMATCHED')::int AS unmatched
          FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
         WHERE r.company_id = ${CO} AND r.confirmed_at IS NULL AND coalesce(r.bucket, '') <> 'IGNORED'
           AND r.txn_date BETWEEN ${FROM} AND ${TO}
         GROUP BY 1 ORDER BY 1`) {
        row('REPORT_LINES', `co${CO}`, g.acq, g.n, `RM ${rm(g.sen)}`, `bucket UNMATCHED ${g.unmatched}`);
      }

      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
        c.set('houzsUser', { name: 'read-only check', permissions_set: ['*'] });
        await next();
      });
      app.get('/accounting/unmatched-payments', unmatchedPaymentsHandler);
      app.get('/accounting/unmatched-bank-lines', unmatchedBankLinesHandler);

      const pay = await app.request(`/accounting/unmatched-payments?from=${FROM}&to=${TO}`);
      const payBody = await pay.json();
      if (pay.status !== 200) row('PAYMENTS_REFUSED', `co${CO}`, pay.status, JSON.stringify(payBody).slice(0, 300));
      else {
        for (const [k, x] of tally(payBody.rows, (r) => r.state, (r) => r.amountSen)) row('PAYMENTS', `co${CO}`, k, x.n, `RM ${rm(x.sen)}`);
        const held = payBody.rows.filter((r) => r.state === 'CARD_NOT_IN_BANK');
        for (const [k, x] of tally(held, (r) => (!r.report ? 'no report named'
          : r.report.waitingLines > 0 ? 'report has lines to reconcile'
            : r.report.bankShare > 0 ? 'bank paid part' : 'bank credit not matched'), (r) => r.amountSen)) {
          row('NOT_IN_BANK', `co${CO}`, k, x.n, `RM ${rm(x.sen)}`);
        }
        row('NOT_IN_BANK_REPORTS', `co${CO}`, new Set(held.map((r) => r.report?.batchId)).size);
        row('PAYMENTS_TOTAL', `co${CO}`, payBody.rows.length);
      }

      const bank = await app.request(`/accounting/unmatched-bank-lines?from=${FROM}&to=${TO}`);
      const bankBody = await bank.json();
      if (bank.status !== 200) row('BANK_REFUSED', `co${CO}`, bank.status, JSON.stringify(bankBody).slice(0, 300));
      else {
        for (const [k, x] of tally(bankBody.rows, (r) => `${r.accountCode}|${r.what}`, (r) => r.amountSen)) row('BANK', `co${CO}`, k, x.n, `RM ${rm(x.sen)}`);
        const transfers = bankBody.rows.filter((r) => r.what === 'TRANSFER');
        for (const [k, x] of tally(transfers, (r) => (r.entryCount === 0 ? 'no entry' : r.entryCount === 1 ? 'one entry' : 'several entries'), (r) => r.amountSen)) {
          row('TRANSFER_ENTRIES', `co${CO}`, k, x.n, `RM ${rm(x.sen)}`);
        }
        row('BANK_TOTAL', `co${CO}`, bankBody.rows.length, `RM ${rm(bankBody.rows.reduce((s, r) => s + r.amountSen, 0))}`);
        const sample = bankBody.rows.slice(0, 3).map((r) => `${r.bookedOn} ${r.accountCode} ${r.what} RM ${rm(r.amountSen)} — ${String(r.note ?? '').slice(0, 90)}`);
        for (const s of sample) row('BANK_SAMPLE', `co${CO}`, s);
      }
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
