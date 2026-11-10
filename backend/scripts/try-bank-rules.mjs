#!/usr/bin/env node
// try-bank-rules.mjs — READ ONLY in effect: ONE transaction, always ROLLED BACK.
// The dry run of the 2026-11-10 Bank Recon change on production before it merges:
//   1. migration 20261110T2200 (match_reason may say amount+document);
//   2. for every statement with OPEN lines, the "Leave out already recorded" and
//      "Match the obvious ones now" handlers as the feature branch has them;
//   3. 2990's Hong Leong October read through the month screen's own handler:
//      does it add up now, are the three repeats out, are the five vouchers matched,
//      and is what remains exactly September's open QR line.
// Prints ids, entry numbers and yes/no only — this repository's Actions logs are public.
// Env: DATABASE_URL, COMPANY_IDS (default "1,2").
import "./lib/public-log-guard.mjs";
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { bankStatementAutoMatch, bankStatementRepeats } from '../src/scm/routes/accounting-bank.ts';
import { bankMonthDetail } from '../src/scm/routes/accounting-bank-months.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('try-bank-rules.mjs always rolls back: run it with mode=plan.'); process.exit(1); }
const COMPANY_IDS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const MIGRATION = new URL('../src/db/migrations-pg/20261110T2200_acc_bank_match_reason_amount_document.sql', import.meta.url);
const DATE_AS_TEXT = { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } };
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: DATE_AS_TEXT });
class RolledBack extends Error {}

const appFor = (sb, companyId) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase', sb); c.set('companyId', companyId); c.set('allowedCompanyIds', [companyId]);
    c.set('houzsUser', { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] });
    await next();
  });
  app.post('/bank/statements/:id/repeats', bankStatementRepeats);
  app.post('/bank/statements/:id/auto-match', bankStatementAutoMatch);
  app.get('/bank/months/:accountCode/:month', bankMonthDetail);
  return app;
};
const readLines = (db, companyId) => db`
  SELECT l.id, l.statement_id, s.account_code, to_jsonb(l)->>'state' AS state, l.kind, l.amount_sen,
         (SELECT string_agg(m.je_no || ':' || coalesce(m.match_reason, ''), ',' ORDER BY m.je_no) FROM scm.acc_bank_statement_matches m WHERE m.bank_line_id = l.id) AS held
    FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
   WHERE l.company_id = ${companyId} ORDER BY l.id`;

try {
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(MIGRATION, 'utf8'));
    const def = await tx`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'acc_bank_match_reason'`;
    console.log(`ROW|MIGRATION|${def.map((d) => d.d).join(' ; ')}`);
    const sb = pgrestShim(tx, 'scm');

    for (const companyId of COMPANY_IDS) {
      const app = appFor(sb, companyId);
      const before = await readLines(tx, companyId);
      const withOpen = [...new Set(before.filter((l) => l.state === 'OPEN').map((l) => Number(l.statement_id)))].sort((a, b) => a - b);
      console.log(`ROW|COMPANY|co${companyId}|open lines ${before.filter((l) => l.state === 'OPEN').length}|statements ${withOpen.map((s) => `st${s}`).join(',')}`);
      for (const [step, path] of [['repeats', 'repeats'], ['auto-match', 'auto-match']]) {
        for (const id of withOpen) {
          const res = await app.request(`/bank/statements/${id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const body = await res.json();
          if (res.status !== 200) { console.log(`ROW|${step}|st${id}|refused ${res.status} ${String(body.error ?? '')}`); continue; }
          const n = path === 'repeats' ? Number(body.leftOut ?? 0) : Number(body.matched ?? 0);
          if (n > 0 || Number(body.contraPairs ?? 0) > 0) console.log(`ROW|${step}|st${id}|${n}|${path === 'repeats' ? (body.lineIds ?? []).join(',') : (body.jeNos ?? []).join(',')}|contra pairs ${body.contraPairs ?? 0}`);
        }
      }
      if (sb.__gaps.length > 0) throw new Error(`the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`);
      const after = await readLines(tx, companyId);
      const was = new Map(before.map((l) => [Number(l.id), l]));
      const tally = new Map();
      for (const l of after) {
        const b = was.get(Number(l.id));
        if (!b || (b.state === l.state && b.kind === l.kind && (b.held ?? '') === (l.held ?? ''))) continue;
        const how = l.kind === 'DUPLICATE' ? 'left out as a repeat' : String(l.held ?? '').includes('amount+document') ? 'matched by voucher number' : String(l.held ?? '').includes('amount+name') ? 'matched by amount and name' : `${b.state}->${l.state}`;
        tally.set(`${l.account_code} ${how}`, (tally.get(`${l.account_code} ${how}`) ?? 0) + 1);
        console.log(`ROW|CHANGED|co${companyId}|line ${l.id}|st${l.statement_id}|${b.state}/${b.kind} -> ${l.state}/${l.kind}|${l.held ?? ''}`);
      }
      for (const [k, n] of tally) console.log(`ROW|TALLY|co${companyId}|${k}|${n}`);
    }

    /* 2990's Hong Leong October, as the month screen reads it now. */
    const app2 = appFor(sb, 2);
    const res = await app2.request('/bank/months/310-0020/2026-10');
    const m = await res.json();
    if (res.status !== 200) throw new Error(`October read refused: ${res.status} ${JSON.stringify(m).slice(0, 200)}`);
    const r = m.reconciliation;
    const byId = new Map(m.lines.map((l) => [Number(l.id), l]));
    const state = (id) => `${byId.get(id)?.state ?? '?'}/${byId.get(id)?.kind ?? '?'}`;
    console.log(`ROW|OCT|consistent ${r.consistent}|tallies ${r.tallies}|open lines ${m.lines.filter((l) => l.state === 'OPEN').length}`);
    console.log(`ROW|OCT|repeats 1130 ${state(1130)} 1132 ${state(1132)} 1158 ${state(1158)} · later bill 1192 ${state(1192)}`);
    const pv = [[1191, '2990-JE-2610-0362'], [1193, '2990-JE-2610-0361'], [1194, '2990-JE-2610-0360'], [1200, '2990-JE-2610-0383'], [1203, '2990-JE-2610-0447']];
    for (const [id, je] of pv) {
      const l = byId.get(id);
      console.log(`ROW|OCT|voucher line ${id}|${l?.state}|${(l?.matches ?? []).map((x) => `${x.je_no}:${x.match_reason}`).join(',')}|expected ${je}: ${(l?.matches ?? []).some((x) => x.je_no === je && x.match_reason === 'amount+document') ? 'yes' : 'NO'}`);
    }
    console.log(`ROW|OCT|untouched: the short-paid Houzs Venture line 1202 ${state(1202)}`);
    /* What is left unexplained: September's open QR line, and nothing else? */
    const qr = await tx`SELECT amount_sen FROM scm.acc_bank_statement_lines WHERE company_id = 2 AND to_jsonb(acc_bank_statement_lines)->>'state' = 'OPEN' AND booked_on BETWEEN '2026-09-01' AND '2026-09-30' AND statement_id IN (SELECT id FROM scm.acc_bank_statements WHERE account_code = '310-0020')`;
    const septOpen = qr.reduce((s, x) => s + Number(x.amount_sen), 0);
    console.log(`ROW|OCT|unexplained equals September's open line(s) (${qr.length}): ${Number(r.unexplainedSen) === septOpen ? 'yes' : 'NO'}`);
    throw new RolledBack();
  });
} catch (e) {
  await sql.end();
  if (e instanceof RolledBack) { console.log('\nROLLED BACK — a dry run; nothing was kept.'); process.exit(0); }
  console.error(`ROLLED BACK — ${String(e?.message ?? e)}`);
  process.exit(1);
}
