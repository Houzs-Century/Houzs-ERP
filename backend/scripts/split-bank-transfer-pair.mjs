#!/usr/bin/env node
// split-bank-transfer-pair.mjs — undo an upload's wrong "gross and fee" join: a
// credit and a debit that shared a reference are two movements, not a card
// payout and the fee taken back against it.
//
// WHY. Owner 2026-11-09, 2990's Hong Leong November statement (310-0020,
// statement 21): line 28 read "RM 40,000.00 less RM 33,000.00 charge". Hong
// Leong prints the other party's name as the reference, so 2990's own
// transfers — 40,000 in from its Maybank (2990-MPV-2611-001) and 33,000 out to
// its Alliance (2990-HPV-2611-006), both "2990 HOME SDN. BHD. Transfer" on
// 05/11 — shared it, and the upload joined them. The upload no longer does
// (acc/bank-match.ts groupBankMovements: a charge only against a payout a rule
// recognises, and never above MAX_CHARGE_SHARE of it). This writes a statement
// already in the way the upload now would.
//
// WHICH LINES. Every OPEN line of the statement that carries a charge the app's
// own rule would no longer take: its gross and its charge (as a debit) are
// handed to groupBankMovements with the recognition rules, and two movements
// coming back means split. A line the rule still joins is left alone.
//
// HOW.
// MODE=plan (the default) reads and prints what it would do.
// MODE=rehearse does it inside a transaction, prints the result, rolls back.
// MODE=apply (APPLY=1) with CONFIRM="SPLIT TRANSFER PAIRS" does it in ONE
// transaction:
//   1. the credit row takes back its gross, charge 0, and what the matcher
//      makes of it alone;
//   2. the debit row is written beside it, OPEN — on its own line number: the
//      upload numbered it and never wrote it, so it is the one number missing
//      among that day's lines (statement 21: #22, between #21 and #23 of
//      05/11); failing exactly one such gap, the first number after the
//      credit's that the statement does not use — with the credit's day, words
//      and reference, and what the matcher makes of it;
//   3. the statement's line count goes up by one.
// A line that is not OPEN, or a closed month, is refused. After the commit the
// rows are read again on a FRESH connection.
//
// RE-RUN: harmless — a split line carries no charge, so a second run finds
// nothing to do.
//
// Env: COMPANY_ID, STATEMENT_ID, DATABASE_URL.
//   COMPANY_ID=2 STATEMENT_ID=21 npx tsx scripts/split-bank-transfer-pair.mjs                                  # plan
//   COMPANY_ID=2 STATEMENT_ID=21 REHEARSE=1 npx tsx scripts/split-bank-transfer-pair.mjs                      # do it, roll back
//   COMPANY_ID=2 STATEMENT_ID=21 MODE=apply CONFIRM="SPLIT TRANSFER PAIRS" npx tsx scripts/split-bank-transfer-pair.mjs

import "./lib/public-log-guard.mjs";
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { groupBankMovements, matchBankMovements } from '../src/acc/bank-match.ts';
import { loadLiveMonthLock, loadPayableBatches, loadPayoutAdvices, loadRecognitionRules } from '../src/acc/bank.ts';
import { lockMonthOf, lockedRefusal } from '../src/acc/bank-lock.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
/* REHEARSE=1 too: the shared runner (run-script.yml) passes only plan / apply as MODE. */
const REHEARSE = !APPLY && (MODE === 'rehearse' || process.env.REHEARSE === '1');
const PHRASE = 'SPLIT TRANSFER PAIRS';
const COMPANY_ID = Number(process.env.COMPANY_ID);
const STATEMENT_ID = Number(process.env.STATEMENT_ID);

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) stop('COMPANY_ID is required (1 = Houzs Century, 2 = 2990\'s Home).', 2);
if (!Number.isInteger(STATEMENT_ID) || STATEMENT_ID <= 0) stop('STATEMENT_ID is required (scm.acc_bank_statements.id).', 2);
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);

const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

/** The statement, its lines, and the joined lines the rule now keeps apart. */
async function readPlan(sb) {
  const { data: stmt, error: sErr } = await sb.from('acc_bank_statements')
    .select('id, company_id, account_code, file_name, line_count').eq('id', STATEMENT_ID).eq('company_id', COMPANY_ID).maybeSingle();
  if (sErr) throw new Error(`statement read failed: ${sErr.message}`);
  if (!stmt) throw new Error(`statement ${STATEMENT_ID} is not company ${COMPANY_ID}'s.`);
  const { data: rows, error: lErr } = await sb.from('acc_bank_statement_lines')
    .select('id, line_no, booked_on, description, reference, amount_sen, charge_sen, state, kind')
    .eq('statement_id', STATEMENT_ID).eq('company_id', COMPANY_ID);
  if (lErr) throw new Error(`lines read failed: ${lErr.message}`);
  const [rules, batches, payouts] = await Promise.all([
    loadRecognitionRules(sb), loadPayableBatches(sb, COMPANY_ID), loadPayoutAdvices(sb, COMPANY_ID),
  ]);
  for (const r of [rules, batches, payouts]) if (!r.ok) throw new Error(`load failed: ${r.reason}`);
  const used = new Set((rows ?? []).map((r) => Number(r.line_no)));
  const splits = [];
  for (const r of rows ?? []) {
    const charge = Number(r.charge_sen ?? 0);
    if (!(charge > 0) || Number(r.amount_sen) <= 0) continue;
    const gross = Number(r.amount_sen) + charge;
    /* The number the upload gave the debit: the one missing among the day's lines. */
    const sameDay = (rows ?? []).filter((x) => day(x.booked_on) === day(r.booked_on)).map((x) => Number(x.line_no));
    const gaps = [];
    for (let n = Math.min(...sameDay) + 1; n < Math.max(...sameDay); n += 1) if (!used.has(n)) gaps.push(n);
    let debitNo = gaps.length === 1 ? gaps[0] : Number(r.line_no) + 1;
    while (used.has(debitNo)) debitNo += 1;
    const lines = [
      { lineNo: Number(r.line_no), bookedOn: day(r.booked_on), description: String(r.description ?? ''), reference: r.reference ?? null, amountSen: gross, balanceSen: null },
      { lineNo: debitNo, bookedOn: day(r.booked_on), description: String(r.description ?? ''), reference: r.reference ?? null, amountSen: -charge, balanceSen: null },
    ];
    const movements = groupBankMovements(lines, rules.rules);
    if (movements.length !== 2) continue; // the rule still calls it a payout and its fee
    const [credit, debit] = matchBankMovements({ movements, rules: rules.rules, batches: batches.batches, payouts: payouts.payouts });
    used.add(debitNo);
    splits.push({ row: r, gross, charge, debitNo, credit, debit });
  }
  return { stmt, rows: rows ?? [], splits };
}

const decided = (d) => ({
  kind: d.kind, acquirer_code: d.acquirerCode, trading_date: d.tradingDate, merchant_no: d.merchantNo,
  matched_batch_id: d.batchId, split: d.split.length > 0 ? d.split : null, note: d.clue,
});

// ── Plan ─────────────────────────────────────────────────────────────────────
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
let plan;
try {
  plan = await readPlan(pgrestShim(sql, 'scm'));
} catch (e) {
  await sql.end();
  stop(String(e?.message ?? e));
}
console.log(`${plan.stmt.file_name} (${plan.stmt.account_code}, statement ${plan.stmt.id}, ${plan.stmt.line_count} lines) — ${plan.splits.length} line(s) to split:`);
for (const s of plan.splits) {
  console.log(`  line ${s.row.line_no} ${day(s.row.booked_on)} [${s.row.state}] "${s.row.reference ?? ''}": ${rm(s.row.amount_sen)} with ${rm(s.charge)} charge`
    + ` → line ${s.row.line_no} ${rm(s.gross)} (${s.credit.kind}) and line ${s.debitNo} ${rm(-s.charge)} (${s.debit.kind})`);
}
if (plan.splits.length === 0 || (!APPLY && !REHEARSE)) {
  await sql.end();
  console.log(plan.splits.length === 0 ? 'Nothing to do.' : '\nPLAN only — nothing was written. MODE=rehearse to try it and roll back; MODE=apply with the CONFIRM phrase to do it.');
  process.exit(0);
}

// ── Apply (or rehearse), in one transaction ──────────────────────────────────
class Rehearsed extends Error {}
let done;
try {
  done = await sql.begin(async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    /* Planned again INSIDE the transaction, so what is written is what is true now. */
    const now = await readPlan(sb);
    for (const s of now.splits) {
      if (String(s.row.state) !== 'OPEN') throw new Error(`line ${s.row.line_no} is ${s.row.state} — undo its match first.`);
      const held = await loadLiveMonthLock(sb, COMPANY_ID, now.stmt.account_code, lockMonthOf(day(s.row.booked_on)));
      if (!held.ok) throw new Error(`whether ${lockMonthOf(day(s.row.booked_on))} is closed could not be read: ${held.reason}`);
      if (held.lock) throw new Error(lockedRefusal(held.lock, 'splitting a transfer pair').message);
      const { error: upErr } = await sb.from('acc_bank_statement_lines')
        .update({ amount_sen: s.gross, charge_sen: 0, ...decided(s.credit), updated_at: new Date().toISOString() })
        .eq('id', s.row.id).eq('company_id', COMPANY_ID);
      if (upErr) throw new Error(`line ${s.row.line_no}: ${upErr.message}`);
      const { error: insErr } = await sb.from('acc_bank_statement_lines').insert({
        statement_id: STATEMENT_ID, company_id: COMPANY_ID, line_no: s.debitNo, booked_on: day(s.row.booked_on),
        description: s.row.description ?? '', reference: s.row.reference ?? null, amount_sen: -s.charge, charge_sen: 0,
        state: 'OPEN', ...decided(s.debit),
      });
      if (insErr) throw new Error(`line ${s.debitNo}: ${insErr.message}`);
    }
    const { error: cErr } = await sb.from('acc_bank_statements')
      .update({ line_count: Number(now.stmt.line_count) + now.splits.length, updated_at: new Date().toISOString() })
      .eq('id', STATEMENT_ID).eq('company_id', COMPANY_ID);
    if (cErr) throw new Error(`statement line count: ${cErr.message}`);
    if (sb.__gaps.length > 0) throw new Error(`the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`);
    const inside = await shapeProblems(tx, now.splits, Number(now.stmt.line_count) + now.splits.length);
    if (inside.length > 0) throw new Error(`the result is not the expected shape:\n  ${inside.join('\n  ')}`);
    for (const s of now.splits) console.log(`  ${REHEARSE ? 'would split' : 'split'} line ${s.row.line_no}: ${rm(s.gross)} + line ${s.debitNo}: ${rm(-s.charge)}`);
    if (REHEARSE) throw new Rehearsed();
    return now;
  });
} catch (e) {
  await sql.end();
  if (e instanceof Rehearsed) { console.log('\nREHEARSED and ROLLED BACK — the split works; nothing was kept.'); process.exit(0); }
  stop(`ROLLED BACK — nothing was written. ${String(e?.message ?? e)}`);
}
await sql.end();

// ── Verify, on a FRESH connection ────────────────────────────────────────────
const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
let problems;
try {
  problems = await shapeProblems(check, done.splits, Number(done.stmt.line_count) + done.splits.length);
} finally {
  await check.end();
}
if (problems.length > 0) stop(`VERIFY FAILED after commit:\n  ${problems.join('\n  ')}`);
console.log(`\nVerified on a fresh connection: ${done.splits.length} line(s) split.`);

/** What a split must look like — as values, not counts. */
async function shapeProblems(db, splits, lineCount) {
  const out = [];
  for (const s of splits) {
    const [credit] = await db`SELECT amount_sen, charge_sen, state FROM scm.acc_bank_statement_lines WHERE id = ${s.row.id} AND company_id = ${COMPANY_ID}`;
    if (!credit || Number(credit.amount_sen) !== s.gross || Number(credit.charge_sen) !== 0 || credit.state !== 'OPEN') {
      out.push(`line ${s.row.line_no}: reads ${JSON.stringify(credit)}, expected ${s.gross} with no charge, OPEN`);
    }
    const debits = await db`
      SELECT amount_sen, charge_sen, state, booked_on::text AS d, reference FROM scm.acc_bank_statement_lines
       WHERE statement_id = ${STATEMENT_ID} AND company_id = ${COMPANY_ID} AND line_no = ${s.debitNo}`;
    if (debits.length !== 1 || Number(debits[0].amount_sen) !== -s.charge || debits[0].state !== 'OPEN' || debits[0].d !== day(s.row.booked_on)) {
      out.push(`line ${s.debitNo}: reads ${JSON.stringify(debits)}, expected one OPEN ${-s.charge} on ${day(s.row.booked_on)}`);
    }
  }
  const [st] = await db`SELECT line_count FROM scm.acc_bank_statements WHERE id = ${STATEMENT_ID} AND company_id = ${COMPANY_ID}`;
  if (!st || Number(st.line_count) !== lineCount) out.push(`statement line count reads ${st?.line_count}, expected ${lineCount}`);
  return out;
}
