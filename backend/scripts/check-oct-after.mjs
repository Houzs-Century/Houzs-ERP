#!/usr/bin/env node
// check-oct-after.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// After apply-bank-rules-2026-11-10.mjs: 2990's Hong Leong October read through the
// month screen's own handler. Does it add up, are the three repeats out, are the five
// vouchers matched by their number, and is what remains exactly September's open line.
// Prints ids, entry numbers and yes/no only — this repository's Actions logs are public.
// Env: DATABASE_URL.
import "./lib/public-log-guard.mjs";
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { bankMonthDetail } from '../src/scm/routes/accounting-bank-months.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const DATE_AS_TEXT = { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } };
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: DATE_AS_TEXT });
try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase', sb); c.set('companyId', 2); c.set('allowedCompanyIds', [2]);
      c.set('houzsUser', { name: 'read-only check', permissions_set: ['scm.payment_voucher.post'] });
      await next();
    });
    app.get('/bank/months/:accountCode/:month', bankMonthDetail);
    const res = await app.request('/bank/months/310-0020/2026-10');
    const m = await res.json();
    if (res.status !== 200) throw new Error(`October read refused: ${res.status}`);
    const r = m.reconciliation;
    const byId = new Map(m.lines.map((l) => [Number(l.id), l]));
    const state = (id) => `${byId.get(id)?.state ?? '?'}/${byId.get(id)?.kind ?? '?'}`;
    console.log(`ROW|OCT|consistent ${r.consistent}|tallies ${r.tallies}|open lines ${m.lines.filter((l) => l.state === 'OPEN').map((l) => l.id).join(',')}`);
    console.log(`ROW|OCT|repeats 1130 ${state(1130)} 1132 ${state(1132)} 1158 ${state(1158)} · later bill 1192 ${state(1192)}`);
    for (const [id, je] of [[1191, '2990-JE-2610-0362'], [1193, '2990-JE-2610-0361'], [1194, '2990-JE-2610-0360'], [1200, '2990-JE-2610-0383'], [1203, '2990-JE-2610-0447']]) {
      const l = byId.get(id);
      console.log(`ROW|OCT|voucher line ${id}|${l?.state}|${(l?.matches ?? []).map((x) => `${x.je_no}:${x.match_reason}`).join(',')}|as expected ${(l?.matches ?? []).some((x) => x.je_no === je && x.match_reason === 'amount+document') ? 'yes' : 'NO'}`);
    }
    const qr = await tx`SELECT amount_sen FROM scm.acc_bank_statement_lines WHERE company_id = 2 AND to_jsonb(acc_bank_statement_lines)->>'state' = 'OPEN'
       AND booked_on BETWEEN '2026-09-01' AND '2026-09-30' AND statement_id IN (SELECT id FROM scm.acc_bank_statements WHERE account_code = '310-0020')`;
    const septOpen = qr.reduce((s, x) => s + Number(x.amount_sen), 0);
    console.log(`ROW|OCT|what remains equals September's open line(s) (${qr.length}): ${Number(r.unexplainedSen) === septOpen ? 'yes' : 'NO'}`);
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
