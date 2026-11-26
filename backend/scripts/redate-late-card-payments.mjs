#!/usr/bin/env node
// redate-late-card-payments.mjs — a card payment recorded in a later month
// than the swipe Merchant Recon confirmed for it moves to the swipe day.
//
// WHY. The owner, 2026-11-26: a payment Finance's Merchant Recon shows was
// swiped earlier is not the recorded month's income, and of the late ones
// found that day (one swiped the year before, one before the books' first day,
// the rest a month or two late) 「要改」 — move them to the day the card was
// swiped. A payment counts on its own day: the ledger entry, the receipt and
// the deposit invoice all follow it, so a late record puts the money, and the
// deposit's sales, in the wrong month.
//
// WHY A SCRIPT. The app's payment edit refuses these payments: a confirmed
// Merchant Recon line has closed the books over them (acc/payment-reconciled),
// and taking the line back is refused once its statement's money is recorded
// received. Only the DAY moves here. The amount, the method, the card acquirer
// and the confirmed line stay as they are, so the line, its fee entry and the
// bank side still agree with the payment. Everything else runs the app's own
// edit path over DATABASE_URL through lib/pgrest-shim.mjs:
// repostSoPaymentBestEffort (the entry reversed on its own day and booked on
// the new day, the deposit invoice cancelled by contra and issued again on the
// new day, or not at all before the deposit invoices start, the receipt
// following), the UPDATE_PAYMENT audit row with the correction reason, and the
// order's invoices' paid amounts. No entry and no invoice is hand-made.
// AutoCount is not told: only the day changes, and the balance it holds does not.
//
// WHICH PAYMENTS. Card payments (merchant / installment) on an order that is
// not cancelled, settled by a CONFIRMED Merchant Recon line swiped in an
// earlier month than the payment's own day. A payment whose lines are on
// different days is refused and named, never guessed. FOLLOW-UPS: a payment
// this script moved before (its audit rows carry the tag) whose entry or
// deposit invoice is not on its day yet gets them followed, so a run cut off
// mid-way heals on the next one.
//
// HOW.
// MODE=plan (the default) reads and prints each move (order, payment, from and
// to day), the refused ones, the follow-ups, and the plan's id; it writes
// nothing.
// MODE=apply (APPLY=1) with CONFIRM="MOVE LATE CARD PAYMENTS TO THEIR SWIPE DAY"
// and the plan's PLAN_ID: stops, writing nothing, if the selection is no
// longer the plan's. Then each payment, one at a time: its row (version
// compare-and-set), then its entry, deposit invoice and receipt, then its
// audit row and its order's invoices. Any shim gap stops the run.
// Then every payment is read back on a FRESH connection: dated the swipe day,
// the version moved by one, one live payment entry on that day of one debit
// and one credit of its amount, at most one live deposit invoice and that one
// on that day for that amount, none before the deposit invoices start, and
// still one if it had one.
//
// RE-RUN: harmless. A moved payment is on its swipe day, so it is not
// selected again; one whose entry or invoice did not follow is a follow-up
// and gets them, nothing else.
//
// Env: COMPANY_ID (1 = Houzs Century), DATABASE_URL, PLAN_ID (apply),
//      LIMIT (move only the first N, in order then payment id: the first
//      production apply moves one and reads it back before the rest).
//   COMPANY_ID=1 npx tsx scripts/redate-late-card-payments.mjs   # plan
//   COMPANY_ID=1 PLAN_ID=<from the plan> MODE=apply CONFIRM="MOVE LATE CARD PAYMENTS TO THEIR SWIPE DAY" npx tsx scripts/redate-late-card-payments.mjs

import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { AUDIT_TAG, dayOf, followUps, latePaymentMoves, paymentProblems, planId } from './lib/late-card-payments.mjs';
import { repostSoPaymentBestEffort, receiptFieldChange, soPaymentFieldChanges } from '../src/scm/lib/so-payment-row.ts';
import { recordSoAudit } from '../src/scm/lib/so-audit.ts';
import { recomputeSiPaidForOrder } from '../src/scm/lib/si-order-deposit.ts';
import { AMEND_SOURCE, ledgerFieldChange } from '../src/acc/payment-corrections.ts';
import { ledgerFactsOf, repostSoPaymentEdit } from '../src/acc/payment-repost.ts';
import { postSoPayment } from '../src/acc/payments.ts';
import { loadDepositInvoiceSettings, reissueDepositInvoiceBestEffort } from '../src/acc/deposit-invoices.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'MOVE LATE CARD PAYMENTS TO THEIR SWIPE DAY';
const COMPANY_ID = Number(process.env.COMPANY_ID);
const WHO = 'Claude, for the owner (2026-11-26)';
const REASON = "Moved to the day the card was swiped, on the owner's word 2026-11-26 (「要改」): a payment Merchant Recon shows was swiped in an earlier month is not the recorded month's income.";

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) stop('COMPANY_ID is required (1 = Houzs Century).', 2);
const confirm = (process.env.CONFIRM ?? '').trim();
if (APPLY && confirm !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
const PLAN_ID = (process.env.PLAN_ID ?? '').trim();
if (APPLY && !/^[0-9a-f]{12}$/.test(PLAN_ID)) stop('PLAN_ID (the id the plan printed) is required to apply. Nothing was written.', 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);
const limitText = String(process.env.LIMIT ?? '').trim();
if (limitText !== '' && !/^[1-9]\d*$/.test(limitText)) stop('LIMIT must be a whole number above nought.', 2);
const LIMIT = limitText === '' ? null : Number(limitText);

/* A DATE comes back as its 'YYYY-MM-DD' text, as PostgREST hands it to the app
   (issue-missing-deposit-invoices.mjs): postgres.js would hand the app a Date. */
const DATE_AS_TEXT = { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } };
const EDITABLE = 'paid_at, method, amount_sen, merchant_provider, installment_months, online_type, approval_code, account_sheet, collected_by';
const editableOf = (r) => ({
  paid_at: dayOf(r.paid_at), method: r.method, amount_sen: Number(r.amount_sen),
  merchant_provider: r.merchant_provider ?? null, installment_months: r.installment_months ?? null,
  online_type: r.online_type ?? null, approval_code: r.approval_code ?? null,
  account_sheet: r.account_sheet ?? null, collected_by: r.collected_by ?? null,
});

/** Each payment's live SOPAY entry days and live deposit invoice days. */
async function standing(db, ids) {
  const entries = new Map(ids.map((id) => [id, []]));
  const invoices = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return { entries, invoices };
  const je = await db`
    SELECT source_doc_no, entry_date FROM scm.journal_entries
     WHERE company_id = ${COMPANY_ID} AND source_type = 'SOPAY' AND posted AND NOT reversed AND source_doc_no IN ${db(ids)}`;
  for (const e of je) entries.get(String(e.source_doc_no))?.push(dayOf(e.entry_date));
  const di = await db`
    SELECT payment_id::text AS payment_id, invoice_date FROM scm.acc_deposit_invoices
     WHERE company_id = ${COMPANY_ID} AND payment_source = 'SOPAY' AND status <> 'CANCELLED' AND payment_id::text IN ${db(ids)}`;
  for (const d of di) invoices.get(String(d.payment_id))?.push(dayOf(d.invoice_date));
  return { entries, invoices };
}

// ── Plan ─────────────────────────────────────────────────────────────────────
const sql = postgres(process.env.DATABASE_URL, { max: 4, prepare: false, types: DATE_AS_TEXT });
let moves, refused, follow, depositFrom, hadInvoice;
try {
  const rows = await sql`
    SELECT p.id::text AS id, p.so_doc_no, so.status::text AS so_status, p.paid_at, p.method, p.amount_sen, p.version,
           r.id AS row_id, r.txn_date
      FROM scm.acc_settlement_rows r
      JOIN scm.acc_settlement_matches m ON m.settlement_row_id = r.id AND m.company_id = r.company_id
      JOIN scm.mfg_sales_order_payments p ON p.id::text = m.payment_id AND p.company_id = m.company_id
      JOIN scm.mfg_sales_orders so ON so.doc_no = p.so_doc_no AND so.company_id = p.company_id
     WHERE r.company_id = ${COMPANY_ID} AND r.bucket = 'MATCHED' AND r.confirmed_at IS NOT NULL AND m.payment_source = 'SOPAY'`;
  ({ moves, refused } = latePaymentMoves(rows));
  if (LIMIT != null && moves.length > LIMIT) {
    console.log(`LIMIT ${LIMIT}: this run takes the first ${LIMIT} of ${moves.length}; plan again for the rest.`);
    moves = moves.slice(0, LIMIT);
  }

  const tagged = await sql`
    SELECT DISTINCT a.payment_id::text AS id FROM scm.mfg_so_audit_log a
     WHERE a.company_id = ${COMPANY_ID} AND a.action = 'UPDATE_PAYMENT' AND a.payment_id IS NOT NULL AND a.note LIKE ${`${AUDIT_TAG}:%`}`;
  const movedIds = tagged.map((t) => String(t.id)).filter((id) => !moves.some((m) => m.id === id));
  const movedRows = movedIds.length === 0 ? [] : await sql`
    SELECT id::text AS id, so_doc_no, paid_at, amount_sen, method FROM scm.mfg_sales_order_payments
     WHERE company_id = ${COMPANY_ID} AND id::text IN ${sql(movedIds)}`;
  const now = await standing(sql, [...moves.map((m) => m.id), ...movedRows.map((r) => String(r.id))]);
  follow = followUps(movedRows.map((r) => ({ ...r, entryDays: now.entries.get(String(r.id)), invoiceDays: now.invoices.get(String(r.id)) })));
  hadInvoice = new Map(moves.map((m) => [m.id, now.invoices.get(m.id).length > 0]));

  const st = await loadDepositInvoiceSettings(pgrestShim(sql, 'scm'), COMPANY_ID);
  if (!st.ok) throw new Error(`deposit invoice settings: ${st.reason}`);
  depositFrom = st.settings.enabled && st.settings.fromDate ? dayOf(st.settings.fromDate) : null;
} catch (e) {
  await sql.end();
  stop(String(e?.message ?? e));
}

const id = planId(moves, follow);
console.log(`Company ${COMPANY_ID}: ${moves.length} card payment(s) to move to their swipe day; ${refused.length} refused; ${follow.length} follow-up(s). Deposit invoices ${depositFrom ? `from ${depositFrom}` : 'off'}.`);
const byMonths = new Map();
for (const m of moves) {
  const k = `recorded ${m.from.slice(0, 7)}, swiped ${m.to.slice(0, 7)}`;
  byMonths.set(k, (byMonths.get(k) ?? 0) + 1);
}
for (const [k, n] of [...byMonths].sort()) console.log(`  ${k}: ${n}`);
for (const m of moves) console.log(`  MOVE ${m.so_doc_no} payment ${m.id.slice(0, 8)} ${m.from} -> ${m.to}${hadInvoice.get(m.id) ? ' (has a deposit invoice)' : ''}`);
for (const r of refused) console.log(`  REFUSED ${r.so_doc_no} payment ${r.id.slice(0, 8)}: ${r.why}`);
for (const f of follow) console.log(`  FOLLOW-UP ${f.so_doc_no} payment ${f.id.slice(0, 8)}: entry or deposit invoice not on ${f.day} yet`);
console.log(`PLAN_ID ${id}`);

if (moves.length === 0 && follow.length === 0) {
  await sql.end();
  console.log('Nothing to do.');
  process.exit(0);
}
if (!APPLY) {
  await sql.end();
  console.log(`\nPLAN only — nothing was written. To do it: MODE=apply, CONFIRM="${PHRASE}", PLAN_ID=${id}.`);
  process.exit(0);
}
if (PLAN_ID !== id) {
  await sql.end();
  stop(`PLAN_ID ${PLAN_ID} is not this plan (${id}): the payments moved since it was read. Plan again. Nothing was written.`, 2);
}

// ── Apply ────────────────────────────────────────────────────────────────────
const done = [];
const failed = [];
let gap = null;

for (const m of moves) {
  const sb = pgrestShim(sql, 'scm');
  try {
    const { data: row, error } = await sb.from('mfg_sales_order_payments')
      .select(`id, so_doc_no, version, ${EDITABLE}`).eq('id', m.id).eq('company_id', COMPANY_ID).maybeSingle();
    if (error) { failed.push(`${m.so_doc_no} payment ${m.id}: read: ${error.message}`); break; }
    if (!row || dayOf(row.paid_at) !== m.from || Number(row.version) !== m.version) {
      failed.push(`${m.so_doc_no} payment ${m.id}: changed since the plan — plan again`);
      break;
    }
    const before = editableOf(row);
    const next = { ...before, paid_at: m.to };
    const { data: updated, error: upErr } = await sb.from('mfg_sales_order_payments')
      .update({ paid_at: m.to, version: m.version + 1, updated_at: new Date().toISOString() })
      .eq('id', m.id).eq('company_id', COMPANY_ID).eq('version', m.version)
      .select('id, paid_at, version').maybeSingle();
    if (upErr || !updated) { failed.push(`${m.so_doc_no} payment ${m.id}: not moved: ${upErr?.message ?? 'version conflict'}`); break; }
    const ledger = await repostSoPaymentBestEffort(sb, { id: m.id, docNo: m.so_doc_no, companyId: COMPANY_ID, before, next, actor: WHO });
    await recordSoAudit(sb, {
      docNo: m.so_doc_no, action: 'UPDATE_PAYMENT', actorId: null, actorName: WHO, paymentId: m.id,
      fieldChanges: [...soPaymentFieldChanges(before, next), ...ledgerFieldChange(ledger), ...receiptFieldChange(ledger.receipt)],
      source: AMEND_SOURCE,
      note: `${AUDIT_TAG}: ${REASON} Merchant Recon line ${m.row_ids.join(', ')}, swiped ${m.to}; recorded ${m.from}.`,
    });
    await recomputeSiPaidForOrder(sb, m.so_doc_no, COMPANY_ID);
  } catch (e) {
    failed.push(`${m.so_doc_no} payment ${m.id}: ${String(e?.message ?? e)}`);
  }
  if (sb.__gaps.length > 0) { gap = `${m.so_doc_no} payment ${m.id}: the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`; break; }
  if (failed.length > 0) break;
  done.push({ id: m.id, day: m.to, amount_sen: m.amount_sen, version: m.version + 1, hadInvoice: hadInvoice.get(m.id) });
  console.log(`  moved ${m.so_doc_no} payment ${m.id.slice(0, 8)} to ${m.to}`);
}

for (const f of gap || failed.length > 0 ? [] : follow) {
  const sb = pgrestShim(sql, 'scm');
  try {
    const { data: row, error } = await sb.from('mfg_sales_order_payments')
      .select(`id, so_doc_no, company_id, version, ${EDITABLE}`).eq('id', f.id).eq('company_id', COMPANY_ID).maybeSingle();
    if (error || !row) { failed.push(`${f.so_doc_no} payment ${f.id}: read: ${error?.message ?? 'not found'}`); break; }
    const live = await sql`
      SELECT entry_date FROM scm.journal_entries
       WHERE company_id = ${COMPANY_ID} AND source_type = 'SOPAY' AND posted AND NOT reversed AND source_doc_no = ${f.id}`;
    if (live.length > 1) { failed.push(`${f.so_doc_no} payment ${f.id}: ${live.length} live entries — a person must look`); break; }
    const after = { ...editableOf(row), id: f.id, so_doc_no: f.so_doc_no, company_id: COMPANY_ID };
    if (live.length === 0) {
      const booked = await postSoPayment(sb, after);
      if (!booked.ok) { failed.push(`${f.so_doc_no} payment ${f.id}: not booked: ${booked.status} ${booked.reason ?? ''}`); break; }
    } else if (dayOf(live[0].entry_date) !== dayOf(row.paid_at)) {
      const r = await repostSoPaymentEdit(sb, { before: ledgerFactsOf({ ...row, paid_at: dayOf(live[0].entry_date) }), after });
      if (!r.ok) { failed.push(`${f.so_doc_no} payment ${f.id}: not re-posted: ${r.status} ${r.reason}`); break; }
    }
    await reissueDepositInvoiceBestEffort(sb, {
      paymentId: f.id, docNo: f.so_doc_no, paidAt: dayOf(row.paid_at), amountSen: Number(row.amount_sen), method: row.method, actor: WHO,
    });
  } catch (e) {
    failed.push(`${f.so_doc_no} payment ${f.id}: ${String(e?.message ?? e)}`);
  }
  if (sb.__gaps.length > 0) { gap = `${f.so_doc_no} payment ${f.id}: the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`; break; }
  if (failed.length > 0) break;
  done.push({ id: f.id, day: f.day, amount_sen: f.amount_sen, version: null, hadInvoice: false });
  console.log(`  followed up ${f.so_doc_no} payment ${f.id.slice(0, 8)}`);
}
await sql.end();

console.log(`\n${done.length} payment(s) to read back; ${failed.length} failed.`);
for (const f of failed) console.log(`  FAILED ${f}`);
if (gap) console.log(`  STOPPED ${gap}`);

// ── Verify, on a FRESH connection ────────────────────────────────────────────
const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: DATE_AS_TEXT });
const problems = [];
try {
  const ids = done.map((d) => d.id);
  if (ids.length > 0) {
    const rows = await check`
      SELECT id::text AS id, paid_at, version, amount_sen FROM scm.mfg_sales_order_payments
       WHERE company_id = ${COMPANY_ID} AND id::text IN ${check(ids)}`;
    const entries = await check`
      SELECT id::text AS id, source_doc_no, posted, reversed, entry_date FROM scm.journal_entries
       WHERE company_id = ${COMPANY_ID} AND source_type = 'SOPAY' AND source_doc_no IN ${check(ids)}`;
    const entryIds = entries.map((e) => e.id);
    const lines = entryIds.length === 0 ? [] : await check`
      SELECT journal_entry_id::text AS journal_entry_id, debit_sen, credit_sen FROM scm.journal_entry_lines
       WHERE journal_entry_id::text IN ${check(entryIds)}`;
    const invoices = await check`
      SELECT payment_id::text AS payment_id, status, invoice_date, amount_sen FROM scm.acc_deposit_invoices
       WHERE company_id = ${COMPANY_ID} AND payment_source = 'SOPAY' AND payment_id::text IN ${check(ids)}`;
    for (const d of done) {
      problems.push(...paymentProblems({
        want: { id: d.id, day: d.day, amount_sen: d.amount_sen, version: d.version, depositFrom, hadInvoice: d.hadInvoice },
        row: rows.find((r) => r.id === d.id) ?? null,
        entries: entries.filter((e) => String(e.source_doc_no) === d.id)
          .map((e) => ({ ...e, lines: lines.filter((l) => l.journal_entry_id === e.id) })),
        invoices: invoices.filter((v) => v.payment_id === d.id),
      }));
    }
  }
} finally {
  await check.end();
}
if (problems.length > 0) stop(`VERIFY FAILED after the run:\n  ${problems.join('\n  ')}`);
console.log(`Verified on a fresh connection: ${done.length} payment(s), each on its swipe day with one live entry on that day and its deposit invoice, if any, on that day.`);
if (failed.length > 0 || gap) process.exit(1);
