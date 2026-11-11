#!/usr/bin/env node
// check-card-column.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-11 on the Cash Flow's balance lines: 「下面这个是什么？」 — the line
// "Card money not yet in the bank" under "Bank". Reads the shipped report
// (receiptsPaymentsReport) month by month — the Card column's closing, the swipes
// in it, what left it — and the bank side: which statements are filed, and the
// card credits on them still open.
// Prints counts, dates, percentages and yes/no; the guard redacts any money —
// this repository's Actions logs are public.
// Env: DATABASE_URL, COMPANY_IDS (default 1,2).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { receiptsPaymentsReport } from '../src/scm/routes/accounting-rp.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const MONTHS = [['Sep', '2026-09-01', '2026-09-30'], ['Oct', '2026-10-01', '2026-10-31'], ['Nov', '2026-11-01', TODAY]];
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const pct = (a, b) => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)}%`);
const d10 = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    for (const CO of COS) {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
        c.set('houzsUser', { name: 'read-only check', permissions_set: ['*', 'scm.payment_voucher.post'] });
        await next();
      });
      app.get('/rp', receiptsPaymentsReport);
      const read = async (from, to) => {
        const res = await app.request(`/rp?from=${from}&to=${to}`);
        if (res.status !== 200) return { refused: res.status };
        const r = await res.json();
        const bankCodes = (r.columns ?? []).map((c) => c.code).filter((c) => c !== 'CARD');
        const closingBank = bankCodes.reduce((s, c) => s + Number(r.totals?.closing?.[c] ?? 0), 0);
        return {
          card: Number(r.totals?.closing?.CARD ?? 0), openingCard: Number(r.opening?.CARD ?? 0),
          bank: closingBank, takings: Number(r.card?.takingsSen ?? 0), codes: r.card?.codes ?? [], bankCodes,
        };
      };
      const months = {};
      for (const [name, from, to] of MONTHS) months[name] = await read(from, to);
      const whole = await read('2026-09-01', '2026-10-31');
      if (whole.refused) { row('REFUSED', `co${CO}`, whole.refused); continue; }
      const oct = months.Oct;
      row('COLUMNS', `co${CO}`, `card accounts ${whole.codes.join(', ')}`, `bank columns ${whole.bankCodes.join(', ')}`);
      /* Which figures the screenshot shows: Sep's closing as a share of Oct's, for the card and the bank. */
      row('SHAPE', `co${CO}`, `Sep..Oct closing = Oct closing: card ${whole.card === oct.card ? 'yes' : 'no'}, bank ${whole.bank === oct.bank ? 'yes' : 'no'}`,
        `card Sep/Oct ${pct(months.Sep.card, oct.card)}`, `bank Sep/Oct ${pct(months.Sep.bank, oct.bank)}`,
        `bank negative at Oct end ${oct.bank < 0 ? 'yes' : 'no'}`, `bank+card at Oct end vs card ${pct(oct.bank + oct.card, oct.card)}`);
      for (const [name] of MONTHS) {
        const m = months[name];
        if (m.refused) { row('MONTH', `co${CO}`, name, `REFUSED ${m.refused}`); continue; }
        /* What left the card column in the month: the acquirers' payouts booked to a bank, and the fees they kept. */
        const out = m.openingCard + m.takings - m.card;
        row('MONTH', `co${CO}`, name, `closing as share of Oct closing ${pct(m.card, oct.card)}`,
          `swipes in the month as share of Oct closing ${pct(m.takings, oct.card)}`,
          `share of the month's swipes + opening that left for a bank or as fees ${pct(out, m.openingCard + m.takings)}`);
      }

      /* The bank side: statements filed per money account, and the card credits on them. */
      const stmts = await tx`
        SELECT account_code, count(*)::int AS n, min(period_from) AS first_day, max(period_to) AS last_day
          FROM scm.acc_bank_statements WHERE company_id = ${CO} GROUP BY account_code ORDER BY account_code`;
      for (const s of stmts) row('STATEMENTS', `co${CO}`, s.account_code, `files ${s.n}`, `${d10(s.first_day)}..${d10(s.last_day)}`);
      const accounts = (whole.bankCodes ?? []).filter((c) => !stmts.some((s) => s.account_code === c));
      row('NO_STATEMENT', `co${CO}`, accounts.join(', ') || '—');
      const credits = await tx`
        SELECT s.account_code, to_char(l.booked_on, 'YYYY-MM') AS month, l.state, count(*)::int AS n, sum(l.amount_sen)::bigint AS sen
          FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
         WHERE l.company_id = ${CO} AND l.amount_sen > 0 AND l.kind LIKE 'PAYOUT%'
         GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
      for (const c of credits) {
        row('CARD_CREDITS', `co${CO}`, c.account_code, c.month, c.state, `lines ${c.n}`, `share of Oct card closing ${pct(Number(c.sen), oct.card)}`);
      }
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
