#!/usr/bin/env node
// check-unmatched-three-lists.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-10 「关于那个unmatch payment 我要优化 … 我想要显示两样东西：一个就是有卡机报告但
// 没有对应的收款记录，一个就是现有的记录收钱了，但没有对应的卡机报告或收款记录，如果银行那边的收款有，
// 也没有对应的transaction 也可以显示 / 要支持可以export 全部」 — how big each list is today:
//  1. merchant report lines still open, by what the matcher found (no sale / suggested / linked);
//  2. the page's own list today (GET /accounting/unmatched-payments, the shipped handler);
//  3. bank statement money-in lines still OPEN, by kind.
// Env: DATABASE_URL, COMPANY_IDS (default "1,2"), FROM (default 180 days ago), TO (default today MYT).
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { unmatchedPaymentsHandler } from '../src/scm/routes/accounting-unmatched-payments.ts';

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
const head = (t) => console.log(`\n=== ${t}`);

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    for (const CO of COS) {
      head(`company ${CO}, ${FROM}..${TO}`);

      /* 1. Card report lines still open. */
      for (const g of await tx`
        SELECT b.acquirer_code AS acq,
               CASE WHEN EXISTS (SELECT 1 FROM scm.acc_settlement_matches m WHERE m.settlement_row_id = r.id) THEN 'linked, waiting confirm'
                    WHEN r.bucket = 'UNMATCHED' THEN 'no sale in the ERP'
                    ELSE 'suggested / several possible' END AS what,
               count(*)::int AS n, coalesce(sum(r.gross_sen), 0)::bigint AS sen,
               min(r.txn_date)::text AS first, max(r.txn_date)::text AS last
          FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
         WHERE r.company_id = ${CO} AND r.confirmed_at IS NULL AND coalesce(r.bucket, '') <> 'IGNORED'
         GROUP BY 1, 2 ORDER BY 1, 2`) {
        row('REPORT_LINES', `co${CO}`, g.acq, g.what, g.n, `RM ${rm(g.sen)}`, `${g.first}..${g.last}`);
      }

      /* 2. The page's own list. */
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
        c.set('houzsUser', { name: 'read-only check', permissions_set: ['*'] });
        await next();
      });
      app.get('/accounting/unmatched-payments', unmatchedPaymentsHandler);
      const res = await app.request(`/accounting/unmatched-payments?from=${FROM}&to=${TO}`);
      const body = await res.json();
      if (res.status !== 200) row('REFUSED', `co${CO}`, res.status, JSON.stringify(body).slice(0, 300));
      else {
        const t = new Map();
        for (const r of body.rows) { const k = `${r.kind}|${r.state}`; const x = t.get(k) ?? { n: 0, sen: 0 }; x.n += 1; x.sen += Number(r.amountSen); t.set(k, x); }
        for (const [k, x] of [...t].sort()) row('PAYMENTS', `co${CO}`, k, x.n, `RM ${rm(x.sen)}`);
        row('PAYMENTS_TOTAL', `co${CO}`, body.rows.length);
      }

      /* 3. Bank money-in lines still open. */
      for (const g of await tx`
        SELECT s.account_code, l.kind, count(*)::int AS n, sum(l.amount_sen)::bigint AS sen, min(l.booked_on)::text AS first, max(l.booked_on)::text AS last
          FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
         WHERE l.company_id = ${CO} AND l.state = 'OPEN' AND l.amount_sen > 0
         GROUP BY 1, 2 ORDER BY 1, 2`) {
        row('BANK_IN', `co${CO}`, g.account_code, g.kind, g.n, `RM ${rm(g.sen)}`, `${g.first}..${g.last}`);
      }
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
