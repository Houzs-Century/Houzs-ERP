#!/usr/bin/env node
// backfill-autocount-deposit-notes.mjs — the AutoCount deposit note for every
// carried-over order already invoiced since the books started.
//
// WHY. AutoCount counted the deposits it took as deposit sales at each month
// end and booked 34% of them as cost (owner 2026-11-25); the ERP's invoice
// counts the whole order as sales again. The owner, 2026-11-26: 「从sales 扣回来，
// 但是是开cn 的方式吧，account 不要放在sales 那边一起」. From this change on, an
// order's first sales invoice dated after the books' opening day raises one
// credit note for the deposit the order took in AutoCount, dated the invoice
// day, the invoice's party: Dr DEPOSIT SALES BOOKED IN AUTOCOUNT (511-0000,
// SALES ADJUSTMENTS) / Cr AR, its entry also Dr 410-0080 ACCRUAL - COST OF GOOD
// SOLD / Cr 619-0000 COST OF PURCHASE BASED ON DEPOSIT for 34% of it
// (acc/autocount-deposits.ts, acc/credit-notes.ts).
// The invoices raised between the books' start and that change never passed
// the hook; this raises their notes with the app's own code, driven over
// DATABASE_URL through lib/pgrest-shim.mjs, so no note and no entry is hand-made.
//
// WHICH ORDERS. The rule the hook follows, read in SQL: an order of the company
// with AutoCount money (payment rows of method 'imported' above nought, dated
// before the books' first day), a live, non-migrated sales invoice dated on or
// after the books' first day that has posted its revenue (the earliest such is
// the note's), and no live AutoCount deposit note yet. An order whose only such
// invoice bills RM 0 gets none (no sale, no receivable: AutoCount invoiced it
// before the books). EXCLUDE (comma list of order numbers) leaves orders out —
// one whose AutoCount deposit Finance already settled by hand.
// PAID_BY_OPENING (comma list) names orders whose balance the import dated after
// the opening day (AutoCount kept no payment date) though AutoCount's own record
// shows them settled by it (owner 2026-11-26): their note carries ALL their
// AutoCount money. Each must have such later-dated money, or the run stops.
//
// HOW.
// MODE=plan (the default) reads and prints what it would raise; writes nothing.
// MODE=apply (APPLY=1) with CONFIRM="RAISE AUTOCOUNT DEPOSIT NOTES" raises them
// order by order, CONCURRENCY at a time (default 4), each through
// applyAutoCountDepositToInvoice — autocommitted statement by statement, as the
// app runs in production, never one long transaction: the note and journal
// number counters are row-locked until commit, and one transaction per order
// would hold them for every other order. A failure leaves at worst a draft
// note, which the next run (or the next posting of any of the order's
// invoices) posts instead of raising a second one. Any shim gap stops the run.
// Then every order is read back on a FRESH connection: one live note, posted,
// for the order's AutoCount money, on the invoice planned, dated its day, its
// entry Dr the deposit-sales account / Cr AR with the invoice's party, and Dr
// the cost accrual / Cr the deposit cost for 34% of it.
//
// RE-RUN: harmless. An order that carries a posted AutoCount deposit note is not
// selected again; one whose note an earlier run left as a draft is selected and
// the app's function posts that draft instead of raising a second; a
// PAID_BY_OPENING order whose note is raised is passed over.
//
// Env: COMPANY_ID (1 = Houzs Century), DATABASE_URL, EXCLUDE, PAID_BY_OPENING, CONCURRENCY.
//   COMPANY_ID=1 EXCLUDE=HC-SO-000000 PAID_BY_OPENING=HC-SO-000001 npx tsx scripts/backfill-autocount-deposit-notes.mjs   # plan
//   COMPANY_ID=1 EXCLUDE=HC-SO-000000 PAID_BY_OPENING=HC-SO-000001 MODE=apply CONFIRM="RAISE AUTOCOUNT DEPOSIT NOTES" npx tsx scripts/backfill-autocount-deposit-notes.mjs

import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { applyAutoCountDepositToInvoice, invoicePartyOf, AUTOCOUNT_DEPOSIT_REF } from '../src/acc/autocount-deposits.ts';
import { DEFAULT_ROLE_CODES } from '../src/acc/rules.ts';
import { autoCountCostSen } from '../src/acc/autocount-deposit-note.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'RAISE AUTOCOUNT DEPOSIT NOTES';
const COMPANY_ID = Number(process.env.COMPANY_ID);
const list = (v) => [...new Set(String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
const EXCLUDE = new Set(list(process.env.EXCLUDE));
const PAID_BY_OPENING = list(process.env.PAID_BY_OPENING);
const CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.CONCURRENCY || 4) || 4));
const WHO = 'Claude, for the owner (2026-11-26)';

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) stop('COMPANY_ID is required (1 = Houzs Century).', 2);
const confirm = (process.env.CONFIRM ?? '').trim();
if (APPLY && confirm !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);
const both = PAID_BY_OPENING.filter((so) => EXCLUDE.has(so));
if (both.length > 0) stop(`${both.join(', ')}: in both EXCLUDE and PAID_BY_OPENING. Nothing was written.`, 2);

/* A DATE comes back as its 'YYYY-MM-DD' text, as PostgREST hands it to the app
   (confirm-banked-receipts.mjs): postgres.js would hand the app a Date, and the
   books' opening day would read as no day at all. */
const DATE_AS_TEXT = { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } };
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

/** The orders to raise, as the hook would: one row each, its earliest posted invoice. */
async function readPlan(sql) {
  const [books] = await sql`SELECT books_start_date FROM scm.acc_company_settings WHERE company_id = ${COMPANY_ID}`;
  if (!books?.books_start_date) throw new Error(`company ${COMPANY_ID} has no books start — nothing to offset.`);
  const start = day(books.books_start_date);
  /* The earliest invoice that POSTED its revenue — an RM 0 invoice posts none,
     so it never stands in front of the order's real one. ac_sen is the note's
     amount: money dated before the books' first day, or all of it for an order
     named in PAID_BY_OPENING. */
  const rows = await sql`
    WITH ac AS (
      SELECT p.so_doc_no,
             COALESCE(SUM(p.amount_sen) FILTER (WHERE p.paid_at < ${start}::date), 0)::bigint AS rule_sen,
             SUM(p.amount_sen)::bigint AS all_sen,
             (p.so_doc_no = ANY(${PAID_BY_OPENING}::text[])) AS paid_by_opening
        FROM scm.mfg_sales_order_payments p
       WHERE p.company_id = ${COMPANY_ID} AND p.method = 'imported' AND p.amount_sen > 0
       GROUP BY p.so_doc_no
      HAVING COALESCE(SUM(p.amount_sen) FILTER (WHERE p.paid_at < ${start}::date), 0) > 0
          OR p.so_doc_no = ANY(${PAID_BY_OPENING}::text[])),
    live AS (
      SELECT s.id, s.invoice_number, s.invoice_date, s.so_doc_no, s.debtor_code, s.debtor_name, s.total_sen,
             EXISTS (SELECT 1 FROM scm.journal_entries j
                      WHERE j.company_id = ${COMPANY_ID} AND j.source_type = 'SI' AND j.source_doc_no = s.invoice_number
                        AND j.posted AND NOT COALESCE(j.reversed, FALSE)) AS revenue_posted
        FROM scm.sales_invoices s JOIN ac ON ac.so_doc_no = s.so_doc_no
       WHERE s.company_id = ${COMPANY_ID}
         AND s.status NOT IN ('DRAFT', 'CANCELLED') AND COALESCE(s.migrated_no_stock, FALSE) = FALSE
         AND s.invoice_date >= ${start}::date),
    si AS (
      SELECT DISTINCT ON (live.so_doc_no) live.*
        FROM live
       ORDER BY live.so_doc_no, live.revenue_posted DESC, (live.total_sen > 0) DESC, live.invoice_date, live.invoice_number)
    SELECT si.*, ac.rule_sen, ac.all_sen, ac.paid_by_opening,
           (CASE WHEN ac.paid_by_opening THEN ac.all_sen ELSE ac.rule_sen END)::bigint AS ac_sen,
           EXISTS (SELECT 1 FROM scm.acc_credit_notes n
                    WHERE n.company_id = ${COMPANY_ID} AND n.kind = 'CN' AND n.so_doc_no = si.so_doc_no
                      AND n.source_doc_no = ${AUTOCOUNT_DEPOSIT_REF} AND n.status = 'DRAFT') AS has_draft
      FROM si JOIN ac ON ac.so_doc_no = si.so_doc_no
     WHERE NOT EXISTS (SELECT 1 FROM scm.acc_credit_notes n
                        WHERE n.company_id = ${COMPANY_ID} AND n.kind = 'CN' AND n.so_doc_no = si.so_doc_no
                          AND n.source_doc_no = ${AUTOCOUNT_DEPOSIT_REF} AND n.status = 'POSTED')
     ORDER BY si.invoice_date, si.invoice_number`;
  const mine = rows.filter((r) => !EXCLUDE.has(r.so_doc_no));
  const take = mine.filter((r) => r.revenue_posted);
  const zero = mine.filter((r) => !r.revenue_posted && !(Number(r.total_sen) > 0));
  const unposted = mine.filter((r) => !r.revenue_posted && Number(r.total_sen) > 0);
  const excluded = rows.filter((r) => EXCLUDE.has(r.so_doc_no));
  /* A name in PAID_BY_OPENING that changes nothing is a typo or a wrong order —
     unless its note is already raised (a re-run). */
  const noted = new Set((await sql`
    SELECT DISTINCT n.so_doc_no FROM scm.acc_credit_notes n
     WHERE n.company_id = ${COMPANY_ID} AND n.kind = 'CN' AND n.source_doc_no = ${AUTOCOUNT_DEPOSIT_REF}
       AND n.status <> 'CANCELLED' AND n.so_doc_no = ANY(${PAID_BY_OPENING}::text[])`).map((r) => r.so_doc_no));
  const wrong = PAID_BY_OPENING.filter((so) => {
    if (noted.has(so)) return false;
    const r = take.find((t) => t.so_doc_no === so);
    return !r || !(Number(r.all_sen) > Number(r.rule_sen));
  });
  return { start, take, zero, unposted, excluded, wrong };
}

/** The codes the notes book to (roles, else the defaults) — each must be a live
    posting account of the company, or nothing is raised. */
const ROLES = ['AUTOCOUNT_DEPOSIT_SALES', 'AUTOCOUNT_COST_ACCRUAL', 'AUTOCOUNT_DEPOSIT_COST', 'AR'];
async function roleCodes(sql) {
  const rows = await sql`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = ${COMPANY_ID} AND role = ANY(${ROLES}::text[])`;
  const by = new Map(rows.map((r) => [r.role, r.account_code]));
  const code = (role) => by.get(role) ?? DEFAULT_ROLE_CODES[role];
  const codes = { sales: code('AUTOCOUNT_DEPOSIT_SALES'), accrual: code('AUTOCOUNT_COST_ACCRUAL'), cost: code('AUTOCOUNT_DEPOSIT_COST'), ar: code('AR') };
  const chart = await sql`SELECT account_code FROM scm.accounts WHERE company_id = ${COMPANY_ID} AND is_active
                            AND account_code = ANY(${Object.values(codes)}::text[])`;
  const live = new Set(chart.map((r) => r.account_code));
  const missing = Object.values(codes).filter((c) => !live.has(c));
  if (missing.length > 0) throw new Error(`company ${COMPANY_ID} has no live account ${missing.join(', ')} — nothing to raise the notes on.`);
  return codes;
}

// ── Plan ─────────────────────────────────────────────────────────────────────
const sql = postgres(process.env.DATABASE_URL, { max: CONCURRENCY + 1, prepare: false, types: DATE_AS_TEXT });
let plan;
let codes;
try {
  plan = await readPlan(sql);
  codes = await roleCodes(sql);
} catch (e) {
  await sql.end();
  stop(String(e?.message ?? e));
}
const byMonth = new Map();
for (const r of plan.take) {
  const m = day(r.invoice_date).slice(0, 7);
  const t = byMonth.get(m) ?? { orders: 0, sen: 0, cost: 0 };
  t.orders += 1; t.sen += Number(r.ac_sen); t.cost += autoCountCostSen(Number(r.ac_sen));
  byMonth.set(m, t);
}
const totalSen = plan.take.reduce((s, r) => s + Number(r.ac_sen), 0);
const costSen = plan.take.reduce((s, r) => s + autoCountCostSen(Number(r.ac_sen)), 0);
console.log(`Company ${COMPANY_ID}, books from ${plan.start}: ${plan.take.length} order(s) to raise, ${rm(totalSen)} Dr ${codes.sales} / Cr ${codes.ar}; cost released ${rm(costSen)} Dr ${codes.accrual} / Cr ${codes.cost}.`);
for (const [m, t] of [...byMonth].sort()) console.log(`  invoices of ${m}: ${t.orders} order(s), ${rm(t.sen)}, cost released ${rm(t.cost)}`);
for (const r of plan.take) {
  const late = r.paid_by_opening ? ` (all its AutoCount money: ${rm(Number(r.all_sen) - Number(r.rule_sen))} the import dated after the opening day was paid by it)` : '';
  console.log(`  ${r.so_doc_no} at ${r.invoice_number} (${day(r.invoice_date)}): ${rm(r.ac_sen)}${late}`);
}
if (plan.zero.length > 0) {
  console.log(`No note — their invoice since the books started bills RM 0, ${plan.zero.length}:`);
  for (const r of plan.zero) console.log(`  ${r.so_doc_no} at ${r.invoice_number} (${day(r.invoice_date)})`);
}
if (plan.unposted.length > 0) {
  console.log(`Left for their invoice's own posting (no invoice of theirs has posted revenue yet), ${plan.unposted.length}:`);
  for (const r of plan.unposted) console.log(`  ${r.so_doc_no} at ${r.invoice_number} (${day(r.invoice_date)})`);
}
if (plan.excluded.length > 0) {
  console.log(`Left out by EXCLUDE, ${plan.excluded.length}:`);
  for (const r of plan.excluded) console.log(`  ${r.so_doc_no} at ${r.invoice_number} (${day(r.invoice_date)}): ${rm(r.ac_sen)}`);
}
if (plan.wrong.length > 0) {
  await sql.end();
  stop(`PAID_BY_OPENING ${plan.wrong.join(', ')}: not an order to raise with AutoCount money dated after the opening day. Nothing was written.`, 2);
}
if (plan.take.length === 0 || !APPLY) {
  await sql.end();
  console.log(plan.take.length === 0 ? 'Nothing to do.' : '\nPLAN only — nothing was written. Re-run with MODE=apply and the CONFIRM phrase to do it.');
  process.exit(0);
}

// ── Apply, order by order ────────────────────────────────────────────────────
const done = [];
const failed = [];
let gap = null;
const queue = [...plan.take];
async function worker() {
  while (queue.length > 0 && !gap) {
    const r = queue.shift();
    const sb = pgrestShim(sql, 'scm');
    try {
      const party = await invoicePartyOf(sb, COMPANY_ID, { debtor_code: r.debtor_code, debtor_name: r.debtor_name, so_doc_no: r.so_doc_no });
      if (!party.ok) throw new Error(party.reason);
      const res = await applyAutoCountDepositToInvoice(sb, {
        companyId: COMPANY_ID, siId: String(r.id), siNumber: r.invoice_number, soDocNo: r.so_doc_no,
        invoiceDate: day(r.invoice_date), party: party.party, actor: WHO,
        amountSen: r.paid_by_opening ? Number(r.ac_sen) : null,
      });
      if (sb.__gaps.length > 0) { gap = `${r.so_doc_no}: the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`; return; }
      if (!res.ok) throw new Error(res.reason);
      /* A draft an earlier run left is posted, never raised a second time. */
      const fine = res.status === 'raised' || (r.has_draft && res.status === 'already_offset');
      if (!fine) throw new Error(`expected a new note, got ${res.status}${res.why ? ` (${res.why})` : ''}`);
      done.push({ row: r, party: party.party, noteNumber: res.noteNumber, jeNo: res.jeNo });
    } catch (e) {
      failed.push({ row: r, reason: String(e?.message ?? e) });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
await sql.end();
console.log(`\nRaised ${done.length} note(s); ${failed.length} failed.`);
for (const f of failed) console.log(`  FAILED ${f.row.so_doc_no} at ${f.row.invoice_number}: ${f.reason}`);
if (gap) stop(`STOPPED: ${gap}`);

// ── Verify, on a FRESH connection ────────────────────────────────────────────
const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: DATE_AS_TEXT });
let problems;
try {
  problems = await shapeProblems(check, done, codes);
} finally {
  await check.end();
}
if (problems.length > 0) stop(`VERIFY FAILED after the run:\n  ${problems.join('\n  ')}`);
console.log(`Verified on a fresh connection: ${done.length} order(s), each one posted note for its AutoCount deposit, Dr ${codes.sales} / Cr ${codes.ar}, its cost Dr ${codes.accrual} / Cr ${codes.cost}.`);
if (failed.length > 0) process.exit(1);

/** Everything a raised note must look like — values, not counts. */
async function shapeProblems(db, raised, roleCode) {
  const out = [];
  if (raised.length === 0) return out;
  const orders = raised.map((d) => d.row.so_doc_no);
  const notes = await db`
    SELECT n.id, n.note_number, n.so_doc_no, n.sales_invoice_id, n.note_date, n.total_sen, n.status, n.je_no, n.party_code
      FROM scm.acc_credit_notes n
     WHERE n.company_id = ${COMPANY_ID} AND n.kind = 'CN' AND n.source_doc_no = ${AUTOCOUNT_DEPOSIT_REF}
       AND n.status <> 'CANCELLED' AND n.so_doc_no IN ${db(orders)}`;
  const jeNos = notes.map((n) => n.je_no).filter(Boolean);
  const lines = jeNos.length === 0 ? [] : await db`
    SELECT j.je_no, j.entry_date, j.posted, l.account_code, l.debit_sen, l.credit_sen, l.party_code
      FROM scm.journal_entries j JOIN scm.journal_entry_lines l ON l.journal_entry_id = j.id
     WHERE j.company_id = ${COMPANY_ID} AND j.source_type = 'CN' AND j.je_no IN ${db(jeNos)}`;
  for (const d of raised) {
    const mine = notes.filter((n) => n.so_doc_no === d.row.so_doc_no);
    if (mine.length !== 1) { out.push(`${d.row.so_doc_no}: ${mine.length} live AutoCount notes, expected one`); continue; }
    const n = mine[0];
    if (n.status !== 'POSTED') out.push(`${d.row.so_doc_no}: ${n.note_number} is ${n.status}`);
    if (String(n.sales_invoice_id) !== String(d.row.id)) out.push(`${d.row.so_doc_no}: ${n.note_number} is on another invoice`);
    if (day(n.note_date) !== day(d.row.invoice_date)) out.push(`${d.row.so_doc_no}: ${n.note_number} dated ${day(n.note_date)}, not the invoice's ${day(d.row.invoice_date)}`);
    if (Number(n.total_sen) !== Number(d.row.ac_sen)) out.push(`${d.row.so_doc_no}: ${n.note_number} is not the order's AutoCount deposit`);
    if ((n.party_code ?? null) !== (d.party.code ?? null)) out.push(`${d.row.so_doc_no}: ${n.note_number} credits another party`);
    const je = lines.filter((l) => l.je_no === n.je_no);
    const sen = Number(d.row.ac_sen);
    const cost = autoCountCostSen(sen);
    const one = (code, dr, cr, party) => je.filter((l) => l.account_code === code && Number(l.debit_sen) === dr && Number(l.credit_sen) === cr
      && (party === undefined || (l.party_code ?? null) === party)).length === 1;
    const shaped = one(roleCode.sales, sen, 0) && one(roleCode.ar, 0, sen, d.party.code ?? null)
      && (cost > 0 ? je.length === 4 && one(roleCode.accrual, cost, 0) && one(roleCode.cost, 0, cost) : je.length === 2);
    if (!shaped || je.some((l) => !l.posted) || je.some((l) => day(l.entry_date) !== day(d.row.invoice_date))) {
      out.push(`${d.row.so_doc_no}: entry ${n.je_no ?? '(none)'} is not one posted entry on the invoice day: Dr ${roleCode.sales} / Cr ${roleCode.ar}, Dr ${roleCode.accrual} / Cr ${roleCode.cost} for 34%`);
    }
  }
  return out;
}
