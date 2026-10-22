#!/usr/bin/env node
// settle-bank-fee-pairs.mjs — join a card payout's gross-and-fee pair that a
// bank statement uploaded before 2026-10-15 holds as two rows, then book it.
//
// WHY. The owner, 2026-10-15, on 2990's Maybank September (310-0010): 这一笔
// RM4048.00是要扣RM18.22的 … 做，这笔你也帮我处理.
//   - The statement PDF printed the payout's gross (+4,048.00, line 11) and the
//     fee taken back (−18.22, line 13) with no reference, so the upload kept
//     them apart.
//   - Neither row matched report 027032649949_DVS04E_1_20260906 (owed
//     4,029.78) on its own.
// Uploads join such a pair now (acc/bank-match.ts groupBankMovements). This
// does the same for a statement already in, then books each joined credit that
// is exactly one report's. Both steps are the app's own code, driven over
// DATABASE_URL through lib/pgrest-shim.mjs, so no row and no entry is
// hand-made:
//   - acc/bank-regroup.ts applyRegroup joins the pair;
//   - acc/bank-receive.ts postBankCredit is what the bank screen's Money
//     received runs.
//
// HOW.
// MODE=plan (the default) reads and prints what it would join and book.
// MODE=apply (APPLY=1) with CONFIRM="JOIN AND BOOK FEE PAIRS" runs everything
// in ONE transaction:
//   1. join: the credit row takes the net, the charge and the decision; the
//      fee row goes;
//   2. book: a receipt against the one report (Dr bank / Cr transit), and the
//      movement marked POSTED;
//   3. read the result back inside the transaction. Any shim gap, refusal or
//      wrong shape throws, and the transaction rolls back to nothing.
// After the commit everything is read again on a FRESH connection.
//
// RE-RUN: harmless.
//   - A joined credit carries a charge and its fee row is gone, so a second run
//     finds no pair to join and books nothing.
//   - A credit already booked is POSTED and is never offered again.
//   - A run that fails rolls back whole, so there is no half-joined pair to
//     find the next time.
//
// Env: COMPANY_ID, STATEMENT_ID, DATABASE_URL.
//   COMPANY_ID=2 STATEMENT_ID=15 npx tsx scripts/settle-bank-fee-pairs.mjs                          # plan
//   COMPANY_ID=2 STATEMENT_ID=15 MODE=apply CONFIRM="JOIN AND BOOK FEE PAIRS" npx tsx scripts/settle-bank-fee-pairs.mjs

import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { planRegroup, applyRegroup } from '../src/acc/bank-regroup.ts';
import { postBankCredit } from '../src/acc/bank-receive.ts';
import { loadRecognitionRules, loadPayableBatches, loadPayoutAdvices } from '../src/acc/bank.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'JOIN AND BOOK FEE PAIRS';
const COMPANY_ID = Number(process.env.COMPANY_ID);
const STATEMENT_ID = Number(process.env.STATEMENT_ID);
const WHO = 'Claude, for the owner (2026-10-15)';

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) stop('COMPANY_ID is required (1 = Houzs Century, 2 = 2990\'s Home).', 2);
if (!Number.isInteger(STATEMENT_ID) || STATEMENT_ID <= 0) stop('STATEMENT_ID is required (scm.acc_bank_statements.id).', 2);
const confirm = (process.env.CONFIRM ?? '').trim();
if (APPLY && confirm !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);

const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What one statement holds, and the pairs the upload would now join. */
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
  const pairs = planRegroup(rows ?? [], rules.rules, batches.batches, payouts.payouts);
  return { stmt, rows: rows ?? [], pairs };
}
const books = (p) => p.decision.kind === 'PAYOUT' && p.decision.matched_batch_id != null;

// ── Plan ─────────────────────────────────────────────────────────────────────
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
let plan;
try {
  plan = await readPlan(pgrestShim(sql, 'scm'));
} catch (e) {
  await sql.end();
  stop(String(e?.message ?? e));
}
console.log(`${plan.stmt.file_name} (${plan.stmt.account_code}, statement ${plan.stmt.id}) — ${plan.pairs.length} pair(s) to join:`);
for (const p of plan.pairs) {
  console.log(`  line ${p.lineNo} ${p.bookedOn}: gross ${rm(p.grossSen)} less fee ${rm(p.chargeSen)} (row ${p.feeIds.join(', ')}) = ${rm(p.netSen)}`
    + ` → ${p.decision.kind}${books(p) ? `, books report ${p.decision.matched_batch_id}` : ' — joined only, left for a person'}`);
  console.log(`    ${p.decision.note ?? ''}`);
}
if (plan.pairs.length === 0 || !APPLY) {
  await sql.end();
  console.log(plan.pairs.length === 0 ? 'Nothing to do.' : '\nPLAN only — nothing was written. Re-run with MODE=apply and the CONFIRM phrase to do it.');
  process.exit(0);
}

// ── Apply, in one transaction ────────────────────────────────────────────────
let done;
try {
  done = await sql.begin(async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    /* Planned again INSIDE the transaction, so what is written is what is true now. */
    const now = await readPlan(sb);
    const regrouped = await applyRegroup(sb, COMPANY_ID, now.stmt, now.pairs);
    if (!regrouped.ok) throw new Error(`JOIN refused: ${regrouped.reason}`);
    const booked = [];
    for (const p of regrouped.joined) {
      if (!books(p)) continue;
      const line = now.rows.find((r) => Number(r.id) === p.creditId);
      const r = await postBankCredit(sb, COMPANY_ID,
        { id: p.creditId, booked_on: p.bookedOn, reference: line?.reference ?? null, statement_id: STATEMENT_ID },
        [{ batchId: Number(p.decision.matched_batch_id), amountSen: p.netSen }], null, WHO);
      if (!r.ok) throw new Error(`BOOKING line ${p.lineNo} refused: ${JSON.stringify(r.body)}`);
      booked.push({ pair: p, jeNo: r.posted[0]?.jeNo ?? null });
    }
    if (sb.__gaps.length > 0) throw new Error(`the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`);
    /* The same questions the fresh connection asks below, asked before commit. */
    const inside = await shapeProblems(tx, now.stmt, regrouped.joined, booked);
    if (inside.length > 0) throw new Error(`the result is not the expected shape:\n  ${inside.join('\n  ')}`);
    return { stmt: now.stmt, joined: regrouped.joined, booked };
  });
} catch (e) {
  await sql.end();
  stop(`ROLLED BACK — nothing was written. ${String(e?.message ?? e)}`);
}
await sql.end();
for (const b of done.booked) console.log(`  booked line ${b.pair.lineNo}: ${rm(b.pair.netSen)} → ${b.jeNo}`);

// ── Verify, on a FRESH connection ────────────────────────────────────────────
const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
let problems;
try {
  problems = await shapeProblems(check, done.stmt, done.joined, done.booked);
} finally {
  await check.end();
}
if (problems.length > 0) stop(`VERIFY FAILED after commit:\n  ${problems.join('\n  ')}`);
console.log(`\nVerified on a fresh connection: ${done.joined.length} pair(s) joined, ${done.booked.length} booked.`);

/** Everything a joined, booked pair must look like — as values, not counts. */
async function shapeProblems(db, stmt, joined, booked) {
  const out = [];
  for (const p of joined) {
    const [credit] = await db`
      SELECT id, state, amount_sen, charge_sen, posted_je_no FROM scm.acc_bank_statement_lines
      WHERE id = ${p.creditId} AND company_id = ${COMPANY_ID}`;
    if (!credit) { out.push(`line ${p.lineNo}: the credit row is missing`); continue; }
    if (Number(credit.amount_sen) !== p.netSen || Number(credit.charge_sen) !== p.chargeSen) {
      out.push(`line ${p.lineNo}: reads ${credit.amount_sen} + charge ${credit.charge_sen}, expected ${p.netSen} + ${p.chargeSen}`);
    }
    const fees = await db`SELECT id, amount_sen FROM scm.acc_bank_statement_lines WHERE id = ANY(${p.feeIds}::bigint[])`;
    if (fees.length !== 0) out.push(`line ${p.lineNo}: fee row(s) still there: ${fees.map((f) => f.id).join(', ')}`);

    const b = booked.find((x) => x.pair.creditId === p.creditId);
    if (!b) continue;
    if (credit.state !== 'POSTED' || typeof credit.posted_je_no !== 'string' || credit.posted_je_no !== b.jeNo) {
      out.push(`line ${p.lineNo}: state ${credit.state} / ${credit.posted_je_no}, expected POSTED / ${b.jeNo}`);
    }
    const receipts = await db`
      SELECT id, batch_id, amount_sen, je_no FROM scm.acc_settlement_receipts
      WHERE bank_line_id = ${p.creditId} AND company_id = ${COMPANY_ID}`;
    if (receipts.length !== 1 || Number(receipts[0].amount_sen) !== p.netSen
      || Number(receipts[0].batch_id) !== Number(p.decision.matched_batch_id) || receipts[0].je_no !== b.jeNo) {
      out.push(`line ${p.lineNo}: receipts read ${JSON.stringify(receipts)}`);
    }
    const legs = await db`
      SELECT account_code, debit_sen, credit_sen FROM scm.v_gl_entries
      WHERE je_no = ${b.jeNo} AND company_id = ${COMPANY_ID}`;
    const bank = legs.find((g) => g.account_code === stmt.account_code);
    const debits = legs.reduce((s, g) => s + Number(g.debit_sen), 0);
    const credits = legs.reduce((s, g) => s + Number(g.credit_sen), 0);
    if (!bank || Number(bank.debit_sen) !== p.netSen || debits !== credits || debits !== p.netSen) {
      out.push(`${b.jeNo}: legs read ${JSON.stringify(legs)}`);
    }
  }
  return out;
}
