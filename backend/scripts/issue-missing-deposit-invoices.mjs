#!/usr/bin/env node
// issue-missing-deposit-invoices.mjs — the deposit invoices a past start day
// leaves behind.
//
// WHY. The owner, 2026-11-26, on when Houzs's deposit invoices start: 「1 Sep
// 2026」 — the books' first day, so every customer payment since then on an
// order not yet invoiced needs its deposit invoice. The page's button (Money in
// › Invoices, POST /deposit-invoices/issue-missing) issues them all in ONE
// Worker request; each costs about fifteen PostgREST calls and a Worker request
// is capped below two thousand (scm/lib/document-line-export.ts), so a backlog
// of a thousand stops after a few dozen and the rest stall on retries. This
// drives the app's own functions — missingDepositInvoices for the selection,
// issueDepositInvoice for each payment, postDepositInvoice for an invoice left
// without its journal — over DATABASE_URL through lib/pgrest-shim.mjs, so no
// invoice and no entry is hand-made.
//
// WHICH PAYMENTS. missingDepositInvoices, as the page counts them: the
// company's payments dated on or after the switch's start day, not imported,
// above nought, with no standing deposit invoice, on a live order (not DRAFT or
// CANCELLED) with no live sales invoice. The switch must be on (Finance › Setup
// › Deposit invoices), or nothing is read.
//
// HOW.
// MODE=plan (the default) reads and prints, month by month, how many this run
// would issue, any invoice still without a journal, and the plan's id; it
// writes nothing.
// MODE=apply (APPLY=1) with CONFIRM="ISSUE MISSING DEPOSIT INVOICES" and the
// plan's PLAN_ID: stops, writing nothing, if the selection is no longer the
// plan's. Then the invoices without a journal are posted, and each month's
// payments are issued in payment-date order (so each month's numbers follow the
// money), the months side by side, through issueDepositInvoice — autocommitted
// statement by statement, as the app runs in production. MAX_PER_MONTH caps
// each month's share of one run (the runner stops at 60 minutes, about 3.5 s an
// invoice from it); the next run carries on in the same order. MONTHS (comma
// list of YYYY-MM) keeps only those months. Any shim gap stops the run.
// Then every payment issued, and every invoice posted, is read back on a FRESH
// connection: one live deposit invoice on the payment and its order, for its
// amount, dated its day and numbered in its month, with a journal that is
// posted and standing, source DI / the invoice's number, dated the invoice day,
// two lines: Dr AR with the invoice's party, Cr DEPOSIT_INCOME, for the amount.
//
// RE-RUN: harmless. A payment with a standing deposit invoice is not selected
// again; an invoice an earlier run left without its journal is posted, never
// issued a second time.
//
// Env: COMPANY_ID (1 = Houzs Century), DATABASE_URL, PLAN_ID (apply),
//      MAX_PER_MONTH, MONTHS.
//   COMPANY_ID=1 MAX_PER_MONTH=300 npx tsx scripts/issue-missing-deposit-invoices.mjs   # plan
//   COMPANY_ID=1 MAX_PER_MONTH=300 PLAN_ID=<from the plan> MODE=apply CONFIRM="ISSUE MISSING DEPOSIT INVOICES" npx tsx scripts/issue-missing-deposit-invoices.mjs

import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { batchByMonth, depositInvoiceProblems, planId } from './lib/deposit-invoice-backlog.mjs';
import { issueDepositInvoice, loadDepositInvoiceSettings, missingDepositInvoices, postDepositInvoice } from '../src/acc/deposit-invoices.ts';
import { DEFAULT_ROLE_CODES } from '../src/acc/rules.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'ISSUE MISSING DEPOSIT INVOICES';
const COMPANY_ID = Number(process.env.COMPANY_ID);
const WHO = 'Claude, for the owner (2026-11-26)';

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) stop('COMPANY_ID is required (1 = Houzs Century).', 2);
const confirm = (process.env.CONFIRM ?? '').trim();
if (APPLY && confirm !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
const PLAN_ID = (process.env.PLAN_ID ?? '').trim();
if (APPLY && !/^[0-9a-f]{12}$/.test(PLAN_ID)) stop('PLAN_ID (the id the plan printed) is required to apply. Nothing was written.', 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);
const monthList = [...new Set(String(process.env.MONTHS ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
if (monthList.some((m) => !/^\d{4}-\d{2}$/.test(m))) stop(`MONTHS must be YYYY-MM, comma separated: ${monthList.join(', ')}`, 2);
const MONTHS = monthList.length > 0 ? new Set(monthList) : null;
const capText = String(process.env.MAX_PER_MONTH ?? '').trim();
if (capText !== '' && !/^[1-9]\d*$/.test(capText)) stop('MAX_PER_MONTH must be a whole number above nought.', 2);
const MAX_PER_MONTH = capText === '' ? null : Number(capText);

/* A DATE comes back as its 'YYYY-MM-DD' text, as PostgREST hands it to the app
   (backfill-autocount-deposit-notes.mjs): postgres.js would hand the app a
   Date, and every payment day would read as no day at all — not due. */
const DATE_AS_TEXT = { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } };
const secs = (t0) => `${Math.round((Date.now() - t0) / 1000)}s`;

/** The two codes a deposit invoice books to (roles, else the defaults); each must be a live account of the company. */
async function roleCodes(db) {
  const wanted = ['AR', 'DEPOSIT_INCOME'];
  const rows = await db`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = ${COMPANY_ID} AND role = ANY(${wanted}::text[])`;
  const by = new Map(rows.map((r) => [r.role, r.account_code]));
  const roles = { AR: by.get('AR') ?? DEFAULT_ROLE_CODES.AR, DEPOSIT_INCOME: by.get('DEPOSIT_INCOME') ?? DEFAULT_ROLE_CODES.DEPOSIT_INCOME };
  const chart = await db`SELECT account_code FROM scm.accounts WHERE company_id = ${COMPANY_ID} AND is_active AND account_code = ANY(${Object.values(roles)}::text[])`;
  const live = new Set(chart.map((r) => r.account_code));
  const missing = Object.values(roles).filter((c) => !live.has(c));
  if (missing.length > 0) throw new Error(`company ${COMPANY_ID} has no live account ${missing.join(', ')} — nothing to book the invoices on.`);
  return roles;
}

// ── Plan ─────────────────────────────────────────────────────────────────────
const sql = postgres(process.env.DATABASE_URL, { max: 10, prepare: false, types: DATE_AS_TEXT });
const planSb = pgrestShim(sql, 'scm');
let settings, payments, unposted, roles;
try {
  const st = await loadDepositInvoiceSettings(planSb, COMPANY_ID);
  if (!st.ok) throw new Error(`settings: ${st.reason}`);
  settings = st.settings;
  if (!settings.enabled || !settings.fromDate) throw new Error(`company ${COMPANY_ID}'s deposit invoices are switched off — turn them on with their start day first (Finance › Setup › Deposit invoices). Nothing was written.`);
  const missing = await missingDepositInvoices(planSb, COMPANY_ID);
  if (!missing.ok) throw new Error(`the backlog: ${missing.reason}`);
  payments = missing.payments;
  unposted = await sql`
    SELECT id, payment_id, di_number, so_doc_no, party_code, party_name, amount_sen, invoice_date
      FROM scm.acc_deposit_invoices
     WHERE company_id = ${COMPANY_ID} AND status = 'ISSUED' AND je_no IS NULL
     ORDER BY invoice_date, di_number`;
  roles = await roleCodes(sql);
  if (planSb.__gaps.length > 0) throw new Error(`the shim met a method it does not implement: ${planSb.__gaps.join(' | ')}`);
} catch (e) {
  await sql.end();
  stop(String(e?.message ?? e));
}

const all = batchByMonth(payments, { months: MONTHS, maxPerMonth: null });
const batches = batchByMonth(payments, { months: MONTHS, maxPerMonth: MAX_PER_MONTH });
const id = planId(batches, unposted);
const count = [...batches.values()].reduce((s, l) => s + l.length, 0);
console.log(`Company ${COMPANY_ID}, deposit invoices from ${settings.fromDate}: ${payments.length} payment(s) without one${MONTHS ? ` (this run: ${[...MONTHS].join(', ')})` : ''}.`);
for (const [month, list] of batches) {
  const left = all.get(month).length - list.length;
  console.log(`  payments of ${month}: ${list.length} to issue this run${left > 0 ? `, ${left} left for the next run` : ''}`);
}
if (unposted.length > 0) console.log(`  issued with no journal yet, to post: ${unposted.length} (${unposted.map((d) => d.di_number).join(', ')})`);
console.log(`Books to Dr ${roles.AR} (the customer) / Cr ${roles.DEPOSIT_INCOME}. PLAN_ID ${id}`);

if (count === 0 && unposted.length === 0) {
  await sql.end();
  console.log('Nothing to do.');
  process.exit(0);
}
if (!APPLY) {
  await sql.end();
  console.log(`\nPLAN only — nothing was written. To do it: MODE=apply, CONFIRM="${PHRASE}", PLAN_ID=${id}, and the same MONTHS / MAX_PER_MONTH.`);
  process.exit(0);
}
if (PLAN_ID !== id) {
  await sql.end();
  stop(`PLAN_ID ${PLAN_ID} is not this plan (${id}): the backlog moved since it was read. Plan again. Nothing was written.`, 2);
}

// ── Apply ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
const checks = [];   // { payment, diNumber } to read back
const failed = [];
const notDue = [];
let gap = null;

/* First the invoices a cut-off run left without their journal. */
for (const d of unposted) {
  const sb = pgrestShim(sql, 'scm');
  const r = await postDepositInvoice(sb, {
    id: String(d.id), companyId: COMPANY_ID, diNumber: d.di_number, soDocNo: d.so_doc_no,
    partyCode: d.party_code, partyName: d.party_name, amountSen: Number(d.amount_sen), invoiceDate: String(d.invoice_date).slice(0, 10),
  });
  if (sb.__gaps.length > 0) { gap = `${d.di_number}: the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`; break; }
  if (!r.ok) failed.push(`${d.di_number}: not posted: ${r.reason}`);
  else checks.push({ payment: { id: String(d.payment_id), so_doc_no: d.so_doc_no, day: String(d.invoice_date).slice(0, 10), amount_sen: Number(d.amount_sen) }, diNumber: d.di_number });
}

/* Then the months side by side, each in its own payment order. */
async function issueMonth(month, list) {
  const sb = pgrestShim(sql, 'scm');
  const started = Date.now();
  let issued = 0;
  for (const p of list) {
    if (gap) return;
    let r;
    try {
      r = await issueDepositInvoice(sb, {
        paymentId: String(p.id), soDocNo: p.so_doc_no, paidAt: p.day, amountSen: Number(p.amount_sen), method: p.method ?? null, createdBy: WHO,
      }, false);
    } catch (e) {
      failed.push(`payment ${p.id} (${p.so_doc_no}): ${String(e?.message ?? e)}`);
      continue;
    }
    if (sb.__gaps.length > 0) { gap = `payment ${p.id}: the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`; return; }
    if (!r.ok) { failed.push(`payment ${p.id} (${p.so_doc_no}): ${r.status}: ${r.reason}`); continue; }
    if (r.status === 'not_due') { notDue.push(`payment ${p.id} (${p.so_doc_no}): ${r.why}`); continue; }
    if (r.status === 'issued' && r.postProblem) failed.push(`payment ${p.id} (${p.so_doc_no}): ${r.diNumber} issued but not posted: ${r.postProblem} — the next run posts it`);
    checks.push({ payment: p, diNumber: r.diNumber });
    issued += 1;
  }
  console.log(`  ${month}: ${issued} of ${list.length} issued in ${secs(started)}`);
}
if (!gap) await Promise.all([...batches].map(([month, list]) => issueMonth(month, list)));
await sql.end();

console.log(`\n${checks.length} deposit invoice(s) to read back; ${notDue.length} no longer due; ${failed.length} failed; ${secs(t0)}.`);
for (const n of notDue) console.log(`  NOT DUE ${n}`);
for (const f of failed) console.log(`  FAILED ${f}`);
if (gap) stop(`STOPPED: ${gap}`);

// ── Verify, on a FRESH connection ────────────────────────────────────────────
const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: DATE_AS_TEXT });
const problems = [];
try {
  for (let i = 0; i < checks.length; i += 500) {
    const part = checks.slice(i, i + 500);
    const ids = part.map((c) => String(c.payment.id));
    const invoices = await check`
      SELECT id, payment_id, payment_source, so_doc_no, amount_sen, invoice_date, di_number, status, je_no, party_code
        FROM scm.acc_deposit_invoices
       WHERE company_id = ${COMPANY_ID} AND payment_source = 'SOPAY' AND payment_id::text IN ${check(ids)}`;
    const jeNos = [...new Set(invoices.map((d) => d.je_no).filter(Boolean))];
    const entries = jeNos.length === 0 ? [] : await check`
      SELECT id::text AS id, je_no, posted, reversed, source_type, source_doc_no, entry_date
        FROM scm.journal_entries
       WHERE company_id = ${COMPANY_ID} AND je_no IN ${check(jeNos)}`;
    const lines = jeNos.length === 0 ? [] : await check`
      SELECT l.journal_entry_id::text AS journal_entry_id, l.account_code, l.debit_sen, l.credit_sen, l.party_code
        FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
       WHERE j.company_id = ${COMPANY_ID} AND j.je_no IN ${check(jeNos)}`;
    for (const c of part) problems.push(...depositInvoiceProblems({ payment: c.payment, invoices, entries, lines, roles }));
  }
} finally {
  await check.end();
}
if (problems.length > 0) stop(`VERIFY FAILED after the run:\n  ${problems.join('\n  ')}`);
console.log(`Verified on a fresh connection: ${checks.length} deposit invoice(s), each the one live invoice on its payment, posted Dr ${roles.AR} (the customer) / Cr ${roles.DEPOSIT_INCOME} on the payment's day.`);
const left = [...all.values()].reduce((s, l) => s + l.length, 0) - count;
if (left > 0) console.log(`${left} payment(s) left for the next run: plan again with the same MAX_PER_MONTH.`);
if (failed.length > 0) process.exit(1);
