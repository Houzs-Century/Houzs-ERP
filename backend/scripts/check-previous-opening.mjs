#!/usr/bin/env node
// check-previous-opening.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-11: money-in records carried from the previous system (AutoCount)
// should be marked "previous" and taken in nowhere — 「银行对账会有两个嘛，一个是我的
// bank statement 的，一个是我account，照理我account的如果选了是之前就代表不应该出现」.
// Whether a bank month still ties then depends on the books' opening: did AutoCount
// already count that money in the bank on the day the books start? This reads the
// shipped month view (bankMonthDetail) for one account's first month and compares
// the books' opening with the statement's against the credits of the books' first day.
// Prints counts, yes/no and percentages; the guard redacts any money (public logs).
// Env: DATABASE_URL, COMPANY_ID (default 1), ACCOUNT (default 310-0010), MONTH (default 2026-09).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { bankMonthDetail } from '../src/scm/routes/accounting-bank-months.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 1);
const ACCOUNT = String(process.env.ACCOUNT || '310-0010');
const MONTH = String(process.env.MONTH || '2026-09');
const FIRST = `${MONTH}-01`;
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const pct = (a, b) => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(2)}%`);
const yn = (b) => (b ? 'yes' : 'no');

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
      c.set('houzsUser', { name: 'read-only check', permissions_set: ['*', 'scm.payment_voucher.post'] });
      await next();
    });
    app.get('/m/:accountCode/:month', bankMonthDetail);
    const res = await app.request(`/m/${ACCOUNT}/${MONTH}`);
    if (res.status !== 200) { row('REFUSED', res.status, JSON.stringify(await res.json()).slice(0, 200)); return; }
    const body = await res.json();
    const r = body.reconciliation ?? {};

    /* The credits on the books' first day: the card money of the days before it, and the rest. */
    const first = await tx`
      SELECT l.state, (l.kind LIKE 'PAYOUT%') AS card, count(*)::int AS n, sum(l.amount_sen)::bigint AS sen
        FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
       WHERE l.company_id = ${CO} AND s.account_code = ${ACCOUNT} AND l.booked_on = ${FIRST} AND l.amount_sen > 0
         AND l.kind <> 'DUPLICATE'
       GROUP BY 1, 2 ORDER BY 1, 2`;
    const cardFirst = first.filter((x) => x.card).reduce((s, x) => s + Number(x.sen), 0);
    const allFirst = first.reduce((s, x) => s + Number(x.sen), 0);
    for (const x of first) row('FIRST_DAY_CREDITS', `${ACCOUNT} ${FIRST}`, x.card ? 'card payout' : 'other', x.state, `lines ${x.n}`, `share of the card ones ${pct(Number(x.sen), cardFirst)}`);

    const bf = r.broughtForwardSen;
    row('MONTH', `${ACCOUNT} ${MONTH}`, `period ${r.periodFrom ?? body.periodFrom ?? '?'}..${r.periodTo ?? body.periodTo ?? '?'}`,
      `tallies ${yn(r.tallies)}`, `consistent ${yn(r.consistent)}`, `reconciled ${yn(r.reconciled)}`,
      `bank not in books lines ${r.bankNotInBooks?.count ?? '?'}`, `books not on bank lines ${r.booksNotOnBank?.count ?? '?'}`);
    if (bf == null) { row('OPENING', 'the month has no statement opening to compare'); return; }
    /* Statement opening minus the books' opening: negative = the books opened HIGHER than the bank. */
    row('OPENING', `books opened higher than the bank ${yn(bf < 0)}`, `books opened lower than the bank ${yn(bf > 0)}`, `same ${yn(bf === 0)}`,
      `gap as share of the first day's card credits ${pct(-bf, cardFirst)}`,
      `gap equals the first day's card credits to the sen ${yn(-bf === cardFirst)}`,
      `gap equals all the first day's credits to the sen ${yn(-bf === allFirst)}`);
    row('UNEXPLAINED', `as share of the first day's card credits ${r.unexplainedSen == null ? 'n/a' : pct(r.unexplainedSen, cardFirst)}`,
      `brought forward explained ${r.broughtForwardExplained == null ? 'n/a' : yn(r.broughtForwardExplained)}`);
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
