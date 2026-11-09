#!/usr/bin/env node
// undo-bank-line.mjs — UNDO ONE BANK RECON MATCH through the app's own route
// (POST /bank/lines/:id/undo — what the screen's Undo button sends), for an
// owner who asked for it. First use, 2026-11-09 「你帮我undo 可以吗我找没有」:
// 2990's 05/11 RM 3,240 "Fund Transfer / THE CONTS SDN. BHD." credit (line 1064)
// was matched by hand to Jenny's QR sale entry 2990-JE-2611-0106, while Jenny's
// money came in the 02/11 QR credit.
//
// The route itself decides what an undo is: it unlinks the movement from its
// entry (and any movement sharing the entry), reopens it, refuses a closed
// month, and posts or reverses nothing for a plain match.
//
// PLAN (default): run inside one transaction that is rolled back — prints the
// line before, the route's answer and the line after. APPLY: MODE=apply and
// CONFIRM="UNDO BANK LINE" — the same, committed, then read back on a fresh
// connection. GUARDS: the line must be the company's, POSTED, of the expected
// amount, holding exactly the expected entry — anything else stops the run.
//
// Env: DATABASE_URL; COMPANY_ID; LINE_ID; EXPECT_AMOUNT_SEN; EXPECT_JE; ACTOR (name on the screen).
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { bankLineUndo } from '../src/scm/routes/accounting-bank.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const wantsApply = process.env.APPLY === '1' || process.env.MODE === 'apply';
if (wantsApply && process.env.CONFIRM !== 'UNDO BANK LINE') { console.error('apply needs CONFIRM="UNDO BANK LINE"'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID);
const LINE = Number(process.env.LINE_ID);
const AMOUNT = Number(process.env.EXPECT_AMOUNT_SEN);
const JE = String(process.env.EXPECT_JE ?? '').trim();
const ACTOR = String(process.env.ACTOR ?? 'Finance (via Claude)').trim();
if (!Number.isInteger(CO) || !Number.isInteger(LINE) || !Number.isInteger(AMOUNT) || !JE) {
  console.error('COMPANY_ID, LINE_ID, EXPECT_AMOUNT_SEN and EXPECT_JE are all required.'); process.exit(2);
}

const opts = { max: 1, prepare: false, types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } };
const sql = postgres(process.env.DATABASE_URL, opts);
const j = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
class Rollback extends Error {}

const snapshot = async (db, label) => {
  const [line] = await db`SELECT id, company_id, booked_on, description, reference, amount_sen, kind, state, posted_je_no, note FROM scm.acc_bank_statement_lines WHERE id = ${LINE}`;
  const matches = await db`SELECT id, bank_line_id, je_no, amount_sen, match_reason, created_at FROM scm.acc_bank_statement_matches WHERE company_id = ${CO} AND (bank_line_id = ${LINE} OR je_no = ${JE}) ORDER BY id`;
  console.log(`${label}: line ${j(line ?? null)}`);
  console.log(`${label}: matches on the line or the entry ${j(matches)}`);
  return { line, matches };
};

try {
  console.log(`${wantsApply ? 'APPLY' : 'PLAN (rolled back)'} — company ${CO}, bank line ${LINE}, expected ${AMOUNT} sen holding ${JE}`);
  try {
    await sql.begin(async (tx) => {
      const before = await snapshot(tx, 'BEFORE');
      const l = before.line;
      if (!l || Number(l.company_id) !== CO) throw new Error(`line ${LINE} is not company ${CO}'s`);
      if (String(l.state) !== 'POSTED') throw new Error(`line ${LINE} is ${l.state}, not POSTED — nothing to undo`);
      if (Number(l.amount_sen) !== AMOUNT) throw new Error(`line ${LINE} is ${l.amount_sen} sen, not ${AMOUNT}`);
      const held = before.matches.filter((m) => Number(m.bank_line_id) === LINE).map((m) => String(m.je_no));
      if (held.length !== 1 || held[0] !== JE) throw new Error(`line ${LINE} holds ${held.join(', ') || 'no entry'}, not exactly ${JE}`);

      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', pgrestShim(tx, 'scm'));
        c.set('companyId', CO);
        c.set('houzsUser', { name: ACTOR, permissions_set: ['scm.payment_voucher.post'] });
        c.set('allowedCompanyIds', [CO]);
        await next();
      });
      app.post('/bank/lines/:id/undo', bankLineUndo);
      const res = await app.request(`/bank/lines/${LINE}/undo`, { method: 'POST' });
      const body = await res.json();
      console.log(`ROUTE: ${res.status} ${j(body)}`);
      if (res.status !== 200) throw new Error(`the Undo route refused: ${j(body)}`);

      await snapshot(tx, 'AFTER');
      if (!wantsApply) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log('PLAN: rolled back — nothing was kept.');
  }
  if (wantsApply) {
    const fresh = postgres(process.env.DATABASE_URL, opts);
    try { await snapshot(fresh, 'VERIFIED ON A FRESH CONNECTION'); } finally { await fresh.end(); }
  }
} catch (e) {
  console.error(`STOPPED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
