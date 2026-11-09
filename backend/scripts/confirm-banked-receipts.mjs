#!/usr/bin/env node
// confirm-banked-receipts.mjs — the draft receipts whose money Bank recon has
// already matched turn formal, the way a match does from now on.
//
// WHY. Owner 2026-11-09, Receipts › Draft · money not confirmed: 这个不是我bank
// recon了就confirm 了？ → 做. A bank match now confirms the receipts of the
// customer payments it holds (acc/receipts.ts formaliseReceiptsForBankMatch,
// called by every match route). The matches made before that left their
// receipts in draft; this confirms them once.
//
// WHICH. Every DRAFT official receipt of COMPANY_ID whose payment's live entry
// (source SOPAY / SIPAY, posted, not reversed) is held by a POSTED line of a
// statement of that entry's own money account — confirmed on that bank, in
// payment-date order (formal numbers are minted in the order money is
// confirmed). Each is confirmed by the app's own formaliseReceipt, driven over
// DATABASE_URL through lib/pgrest-shim.mjs, so no number is hand-made.
//
// HOW.
// MODE=plan (the default) reads and prints what it would confirm, by bank.
// MODE=rehearse confirms inside a transaction, prints the numbers, rolls back.
// MODE=apply (APPLY=1) with CONFIRM="CONFIRM BANKED RECEIPTS" confirms them in
// ONE transaction. A bank with no series letter is reported and its receipts
// stay draft; any other refusal rolls everything back. After the commit the
// receipts are read again on a FRESH connection.
//
// RE-RUN: harmless — a confirmed receipt is FORMAL and is not picked again.
//
// Env: COMPANY_ID, DATABASE_URL.
//   COMPANY_ID=2 npx tsx scripts/confirm-banked-receipts.mjs                                          # plan
//   COMPANY_ID=2 MODE=rehearse npx tsx scripts/confirm-banked-receipts.mjs                            # try, roll back
//   COMPANY_ID=2 MODE=apply CONFIRM="CONFIRM BANKED RECEIPTS" npx tsx scripts/confirm-banked-receipts.mjs

import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { formaliseReceipt } from '../src/acc/receipts.ts';
import { companyCodeById } from '../src/scm/lib/doc-no.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const REHEARSE = MODE === 'rehearse';
const PHRASE = 'CONFIRM BANKED RECEIPTS';
const COMPANY_ID = Number(process.env.COMPANY_ID);
const WHO = 'Claude, for the owner (2026-11-09) — matched in Bank recon';

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) stop('COMPANY_ID is required (1 = Houzs Century, 2 = 2990\'s Home).', 2);
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);

const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

/** The drafts whose money a POSTED bank line holds, oldest payment first, each with its bank. */
async function readPlan(db) {
  const rows = await db`
    SELECT DISTINCT ON (r.id) r.id, r.or_number, r.payment_source, r.payment_id, r.paid_at, r.amount_sen, g.account_code, g.je_no,
           (SELECT b.letter FROM scm.acc_bank_letters b WHERE b.company_id = r.company_id AND b.account_code = g.account_code) AS letter
      FROM scm.acc_official_receipts r
      JOIN scm.v_gl_entries g ON g.company_id = r.company_id AND g.source_type = r.payment_source AND g.source_doc_no = r.payment_id
                             AND g.posted AND NOT COALESCE(g.reversed, false)
      JOIN scm.acc_bank_statement_matches m ON m.company_id = g.company_id AND m.je_no = g.je_no
      JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id AND l.state = 'POSTED'
      JOIN scm.acc_bank_statements s ON s.id = l.statement_id AND s.account_code = g.account_code
     WHERE r.company_id = ${COMPANY_ID} AND r.status = 'DRAFT'
     ORDER BY r.id, l.id`;
  return [...rows].sort((a, b) => day(a.paid_at).localeCompare(day(b.paid_at)) || Number(a.id) - Number(b.id));
}

// ── Plan ─────────────────────────────────────────────────────────────────────
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
let plan;
try {
  plan = await readPlan(sql);
} catch (e) {
  await sql.end();
  stop(String(e?.message ?? e));
}
const byBank = new Map();
for (const r of plan) {
  const k = `${r.account_code} (letter ${r.letter ?? 'NONE — stays draft'})`;
  const at = byBank.get(k) ?? { n: 0, sen: 0, from: day(r.paid_at), to: day(r.paid_at) };
  at.n += 1; at.sen += Number(r.amount_sen); at.to = day(r.paid_at);
  byBank.set(k, at);
}
console.log(`Company ${COMPANY_ID}: ${plan.length} draft receipt(s) whose money a matched bank line holds.`);
for (const [k, v] of byBank) console.log(`  ${k}: ${v.n} receipt(s), ${rm(v.sen)}, paid ${v.from} – ${v.to}`);
for (const r of plan.slice(0, 5)) console.log(`    e.g. ${r.or_number} ${r.payment_source} ${day(r.paid_at)} ${rm(r.amount_sen)} ← ${r.je_no}`);
if (plan.length === 0 || (!APPLY && !REHEARSE)) {
  await sql.end();
  console.log(plan.length === 0 ? 'Nothing to do.' : '\nPLAN only — nothing was written. MODE=rehearse to try it and roll back; MODE=apply with the CONFIRM phrase to do it.');
  process.exit(0);
}

// ── Apply (or rehearse), in one transaction ──────────────────────────────────
class Rehearsed extends Error {}
let done;
try {
  done = await sql.begin(async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    const code = await companyCodeById(sb, COMPANY_ID);
    if (!code) throw new Error(`company ${COMPANY_ID} has no code.`);
    /* Planned again INSIDE the transaction, so what is confirmed is what is true now. */
    const now = await readPlan(tx);
    const confirmed = [];
    const noLetter = [];
    for (const r of now) {
      const f = await formaliseReceipt(sb, { companyId: COMPANY_ID, companyCode: code, receiptId: Number(r.id), accountCode: r.account_code, actor: WHO });
      if (f.ok) { confirmed.push({ r, orNumber: f.orNumber }); continue; }
      if (f.status === 'bank_letter_missing') { noLetter.push(r); continue; }
      throw new Error(`${r.or_number}: ${f.status} — ${f.reason}`);
    }
    if (sb.__gaps.length > 0) throw new Error(`the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`);
    const inside = await shapeProblems(tx, confirmed);
    if (inside.length > 0) throw new Error(`the result is not the expected shape:\n  ${inside.join('\n  ')}`);
    for (const c of confirmed.slice(0, 5)) console.log(`  ${c.r.or_number} → ${c.orNumber} (${c.r.account_code})`);
    console.log(`  ${REHEARSE ? 'would confirm' : 'confirmed'} ${confirmed.length}; left in draft for a missing bank letter: ${noLetter.length}`
      + (noLetter.length > 0 ? ` (${[...new Set(noLetter.map((r) => r.account_code))].join(', ')})` : ''));
    if (REHEARSE) throw new Rehearsed();
    return { confirmed, noLetter };
  });
} catch (e) {
  await sql.end();
  if (e instanceof Rehearsed) { console.log('\nREHEARSED and ROLLED BACK — the confirms work; nothing was kept.'); process.exit(0); }
  stop(`ROLLED BACK — nothing was written. ${String(e?.message ?? e)}`);
}
await sql.end();

// ── Verify, on a FRESH connection ────────────────────────────────────────────
const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
let problems;
try {
  problems = await shapeProblems(check, done.confirmed);
} finally {
  await check.end();
}
if (problems.length > 0) stop(`VERIFY FAILED after commit:\n  ${problems.join('\n  ')}`);
console.log(`\nVerified on a fresh connection: ${done.confirmed.length} receipt(s) formal; ${done.noLetter.length} left in draft for a missing bank letter.`);

/** Each confirmed receipt: FORMAL, on its bank, under the number minted — and no number twice. */
async function shapeProblems(db, confirmed) {
  const out = [];
  if (confirmed.length === 0) return out;
  const ids = confirmed.map((c) => Number(c.r.id));
  const rows = await db`SELECT id, status, or_number, channel_account_code FROM scm.acc_official_receipts WHERE id = ANY(${ids}::bigint[])`;
  const byId = new Map(rows.map((x) => [Number(x.id), x]));
  for (const c of confirmed) {
    const x = byId.get(Number(c.r.id));
    if (!x || x.status !== 'FORMAL' || x.or_number !== c.orNumber || x.channel_account_code !== c.r.account_code) {
      out.push(`${c.r.or_number}: reads ${JSON.stringify(x)}, expected FORMAL ${c.orNumber} on ${c.r.account_code}`);
    }
  }
  const nums = confirmed.map((c) => c.orNumber);
  const twice = nums.filter((n, i) => nums.indexOf(n) !== i);
  if (twice.length > 0) out.push(`numbers minted twice: ${[...new Set(twice)].join(', ')}`);
  return out;
}
