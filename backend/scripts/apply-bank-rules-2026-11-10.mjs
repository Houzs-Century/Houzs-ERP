#!/usr/bin/env node
// apply-bank-rules-2026-11-10.mjs — the two Bank Recon rules of 2026-11-10, run once
// over the statements already uploaded, the way the screen's own buttons run them.
//
// WHY. Owner 2026-11-10, 2990's Hong Leong October:
//   「银行单上写着 PV 号码的，直接配那张 PV，不管差几天」 — 可以. A payment whose words
//   carry its voucher's number (or the Draft number it went out under) is matched to
//   that voucher, however many days apart (acc/bank-match voucherEntryFor).
//   「已经match 了就应该不需要显示」. A month-end print of a movement the any-day file
//   already recorded is a repeat even when worded differently, by a mark both prints
//   carry (acc/bank-repeats printMarks).
// New uploads get both on the way in. The statements already in get them here once.
//
// WHAT. For every statement of COMPANY_IDS that still has OPEN lines, in upload order:
//   1. the "Leave out already recorded" button — POST /bank/statements/:id/repeats;
//   2. then the "Match the obvious ones now" button — POST /bank/statements/:id/auto-match.
// The app's own handlers, driven over DATABASE_URL through lib/pgrest-shim.mjs. A
// statement touching a closed month is refused by the route and reported; the rest run.
// The receipts a customer payment's match confirms are confirmed as Chew (the owner's
// own choice for confirmations made on his behalf, 2026-11-09) — never a sentence.
//
// HOW.
// MODE=plan (the default; REHEARSE=1 the same): everything inside a transaction that is
//   ROLLED BACK, printing what it would change — line ids, statement ids, entry numbers.
// MODE=apply (APPLY=1) with CONFIRM="APPLY BANK RULES 2026-11-10": ONE transaction,
//   committed; then every line it changed is read again on a FRESH connection.
// The log prints ids and entry numbers only: this repository's Actions logs are public.
//
// RE-RUN: harmless — a line left out is IGNORED and a line matched is POSTED, so neither
// is asked again; a second run finds nothing to do.
//
// Env: DATABASE_URL, COMPANY_IDS (default "1,2").
//   npx tsx scripts/apply-bank-rules-2026-11-10.mjs                                                   # plan
//   MODE=apply CONFIRM="APPLY BANK RULES 2026-11-10" npx tsx scripts/apply-bank-rules-2026-11-10.mjs

import "./lib/public-log-guard.mjs";
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { bankStatementAutoMatch, bankStatementRepeats } from '../src/scm/routes/accounting-bank.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'APPLY BANK RULES 2026-11-10';
const ACTOR = 'Chew';
const COMPANY_IDS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);
if (COMPANY_IDS.length === 0) stop('COMPANY_IDS names no company.', 2);

/* A DATE comes back as its 'YYYY-MM-DD' text, as PostgREST hands it to the app (postgres.js would hand a Date). */
const DATE_AS_TEXT = { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } };

/** Every line of the company with its state, kind and match rows — before and after. */
async function readLines(db, companyId) {
  return db`
    SELECT l.id, l.statement_id, s.account_code, to_jsonb(l)->>'state' AS state, l.kind, l.posted_je_no,
           (SELECT string_agg(m.je_no || ':' || coalesce(m.match_reason, ''), ',' ORDER BY m.je_no) FROM scm.acc_bank_statement_matches m WHERE m.bank_line_id = l.id) AS held
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.company_id = ${companyId}
     ORDER BY l.id`;
}

class Rehearsed extends Error {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: DATE_AS_TEXT });
const changed = [];
try {
  await sql.begin(async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    for (const companyId of COMPANY_IDS) {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', sb);
        c.set('companyId', companyId);
        c.set('allowedCompanyIds', [companyId]);
        c.set('houzsUser', { name: ACTOR, permissions_set: ['scm.payment_voucher.post'] });
        await next();
      });
      app.post('/bank/statements/:id/repeats', bankStatementRepeats);
      app.post('/bank/statements/:id/auto-match', bankStatementAutoMatch);

      const before = await readLines(tx, companyId);
      const withOpen = [...new Set(before.filter((l) => l.state === 'OPEN').map((l) => Number(l.statement_id)))].sort((a, b) => a - b);
      console.log(`\nCompany ${companyId}: ${before.filter((l) => l.state === 'OPEN').length} open line(s) on ${withOpen.length} statement(s): ${withOpen.map((id) => `st${id}`).join(', ') || '—'}`);

      /* The repeats of every statement first, so no copy is matched as a movement of its own. */
      for (const [step, path] of [['leave out already recorded', 'repeats'], ['match the obvious ones', 'auto-match']]) {
        for (const id of withOpen) {
          const res = await app.request(`/bank/statements/${id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const body = await res.json();
          if (res.status === 409) { console.log(`  st${id} ${step}: refused — ${String(body.message ?? body.error ?? '').slice(0, 160)}`); continue; }
          if (res.status !== 200) throw new Error(`st${id} ${step}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
          const n = path === 'repeats' ? Number(body.leftOut ?? 0) : Number(body.matched ?? 0);
          if (n > 0 || Number(body.contraPairs ?? 0) > 0) {
            console.log(`  st${id} ${step}: ${n}${path === 'repeats' ? ` — lines ${(body.lineIds ?? []).join(', ')}` : ` — ${(body.jeNos ?? []).join(', ')}`}${Number(body.contraPairs ?? 0) > 0 ? `; ${body.contraPairs} pair(s) the bank reversed` : ''}`);
          }
        }
      }
      if (sb.__gaps.length > 0) throw new Error(`the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`);

      const after = await readLines(tx, companyId);
      const was = new Map(before.map((l) => [Number(l.id), l]));
      for (const l of after) {
        const b = was.get(Number(l.id));
        if (!b || (b.state === l.state && b.kind === l.kind && (b.held ?? '') === (l.held ?? ''))) continue;
        changed.push({ companyId, id: Number(l.id), statementId: Number(l.statement_id), account: l.account_code, from: `${b.state}/${b.kind}`, state: l.state, kind: l.kind, held: l.held ?? '', postedJe: l.posted_je_no ?? '' });
      }
      const mine = changed.filter((c) => c.companyId === companyId);
      const tally = new Map();
      for (const c of mine) {
        const k = c.kind === 'DUPLICATE' ? 'left out as already recorded' : `matched${c.held.includes('amount+document') ? ' by the voucher number' : c.held.includes('amount+name') ? ' by amount and name' : ''}`;
        tally.set(`${c.account} ${k}`, (tally.get(`${c.account} ${k}`) ?? 0) + 1);
      }
      for (const [k, n] of tally) console.log(`  ${k}: ${n}`);
      for (const c of mine) console.log(`    line ${c.id} st${c.statementId} ${c.from} → ${c.state}/${c.kind}${c.held ? ` ${c.held}` : ''}`);
    }
    if (!APPLY) throw new Rehearsed();
  });
} catch (e) {
  await sql.end();
  if (e instanceof Rehearsed) {
    console.log(`\nPLAN — ran inside a transaction and ROLLED BACK; nothing was kept. ${changed.length} line(s) would change. MODE=apply with the CONFIRM phrase to keep it.`);
    process.exit(0);
  }
  stop(`ROLLED BACK — nothing was written. ${String(e?.message ?? e)}`);
}
await sql.end();

// ── Verify, on a FRESH connection ────────────────────────────────────────────
/* Each changed line read again by its values: a repeat IGNORED as DUPLICATE with no
   match row; a match POSTED, its posted entry among its match rows. */
const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const problems = [];
try {
  const ids = changed.map((c) => c.id);
  const rows = ids.length === 0 ? [] : await check`
    SELECT l.id, to_jsonb(l)->>'state' AS state, l.kind, l.posted_je_no,
           (SELECT array_agg(m.je_no) FROM scm.acc_bank_statement_matches m WHERE m.bank_line_id = l.id) AS held
      FROM scm.acc_bank_statement_lines l WHERE l.id = ANY(${ids}::bigint[])`;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const c of changed) {
    const r = byId.get(c.id);
    if (!r) { problems.push(`line ${c.id}: not found`); continue; }
    if (c.kind === 'DUPLICATE') {
      if (r.state !== 'IGNORED' || r.kind !== 'DUPLICATE' || (r.held ?? []).length > 0) problems.push(`line ${c.id}: reads ${r.state}/${r.kind} held ${JSON.stringify(r.held)}, expected IGNORED/DUPLICATE`);
    } else if (c.state === 'POSTED') {
      if (r.state !== 'POSTED' || !(r.held ?? []).includes(String(r.posted_je_no ?? '').split(',')[0]?.trim())) problems.push(`line ${c.id}: reads ${r.state} posted ${r.posted_je_no} held ${JSON.stringify(r.held)}`);
    } else if (r.state !== c.state || r.kind !== c.kind) {
      problems.push(`line ${c.id}: reads ${r.state}/${r.kind}, expected ${c.state}/${c.kind}`);
    }
  }
} finally {
  await check.end();
}
if (problems.length > 0) stop(`VERIFY FAILED after commit:\n  ${problems.join('\n  ')}`);
console.log(`\nAPPLIED and verified on a fresh connection: ${changed.length} line(s) changed as planned.`);
