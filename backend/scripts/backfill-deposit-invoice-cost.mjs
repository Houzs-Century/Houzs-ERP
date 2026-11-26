#!/usr/bin/env node
// backfill-deposit-invoice-cost.mjs — the deposit invoices already posted
// without their cost, posted again with it.
//
// WHY. AutoCount booked 34% of its deposit sales as cost; the ERP's deposit
// invoice booked the sale alone. The owner, 2026-11-26, asked whether deposit
// invoices should book it too: 「记」 — Dr DEPOSIT_COST (619-0000) / Cr
// DEPOSIT_COST_ACCRUAL (410-0080) on the invoice's own entry, released by the
// note that takes the deposit back (acc/deposit-cost.ts). From the moment a
// company's acc_company_settings.deposit_cost_pct is set, every invoice it
// posts carries its cost. The ones posted before never did: this sets the
// share on apply and posts each of them again through the app's own
// repostDepositInvoiceCost — the old entry reversed on its own day, the new
// one with the cost — over DATABASE_URL through lib/pgrest-shim.mjs, so no
// entry is hand-made.
//
// WHICH INVOICES. The company's live deposit invoices (ISSUED) with an entry
// and no cost recorded (cost_sen NULL, or 0 — posted while the company booked
// none). One a note already stands against (its final invoice's, a refund's,
// a move's) is listed and left alone: that note released nothing.
//
// HOW.
// MODE=plan (the default) reads and prints, month by month, how many invoices
// it would post again, the ones left alone, and the plan's id; it writes
// nothing. The share must be PCT (the owner's 34) or not yet set.
// MODE=apply (APPLY=1) with CONFIRM="BOOK DEPOSIT INVOICE COST" and the plan's
// PLAN_ID: stops, writing nothing, if the selection is no longer the plan's.
// Then sets the company's share to PCT — from here every new invoice carries
// its cost — and posts each planned invoice again, CONCURRENCY at a time
// (default 6), autocommitted statement by statement as the app runs in
// production. Any shim gap stops the run.
// Then every invoice is read back on a FRESH connection: it names its new
// entry and records its cost; that entry is its only standing DI entry,
// posted on the invoice day, Dr AR (its party) / Cr DEPOSIT_INCOME for the
// deposit and Dr DEPOSIT_COST / Cr DEPOSIT_COST_ACCRUAL for the cost; the old
// entry is reversed by a posted contra on its own day.
//
// RE-RUN: harmless. An invoice with its cost recorded is not selected again;
// one whose old entry a cut-off run reversed is posted, never reversed twice.
//
// Env: COMPANY_ID (1 = Houzs Century), PCT (34), DATABASE_URL, PLAN_ID (apply), CONCURRENCY.
//   COMPANY_ID=1 PCT=34 npx tsx scripts/backfill-deposit-invoice-cost.mjs   # plan
//   COMPANY_ID=1 PCT=34 PLAN_ID=<from the plan> MODE=apply CONFIRM="BOOK DEPOSIT INVOICE COST" npx tsx scripts/backfill-deposit-invoice-cost.mjs

import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { planId, repostProblems } from './lib/deposit-invoice-cost-backfill.mjs';
import { repostDepositInvoiceCost } from '../src/acc/deposit-invoices.ts';
import { DEFAULT_ROLE_CODES } from '../src/acc/rules.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'BOOK DEPOSIT INVOICE COST';
const COMPANY_ID = Number(process.env.COMPANY_ID);
const PCT = Number(process.env.PCT);
const CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.CONCURRENCY || 6) || 6));

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) stop('COMPANY_ID is required (1 = Houzs Century).', 2);
if (!(PCT > 0 && PCT < 100)) stop('PCT (the share of each deposit booked as cost, e.g. 34) is required.', 2);
const confirm = (process.env.CONFIRM ?? '').trim();
if (APPLY && confirm !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);
const PLAN_ID = (process.env.PLAN_ID ?? '').trim();
if (APPLY && !/^[0-9a-f]{12}$/.test(PLAN_ID)) stop('PLAN_ID (the id the plan printed) is required to apply. Nothing was written.', 2);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);

/* A DATE comes back as its 'YYYY-MM-DD' text, as PostgREST hands it to the app. */
const DATE_AS_TEXT = { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } };
const secs = (t0) => `${Math.round((Date.now() - t0) / 1000)}s`;

/** The four codes the entries book to (roles, else the defaults); each must be a live account of the company. */
async function roleCodes(db) {
  const wanted = ['AR', 'DEPOSIT_INCOME', 'DEPOSIT_COST', 'DEPOSIT_COST_ACCRUAL'];
  const rows = await db`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = ${COMPANY_ID} AND role = ANY(${wanted}::text[])`;
  const by = new Map(rows.map((r) => [r.role, r.account_code]));
  const roles = Object.fromEntries(wanted.map((k) => [k, by.get(k) ?? DEFAULT_ROLE_CODES[k]]));
  const chart = await db`SELECT account_code FROM scm.accounts WHERE company_id = ${COMPANY_ID} AND is_active AND account_code = ANY(${Object.values(roles)}::text[])`;
  const live = new Set(chart.map((r) => r.account_code));
  const missing = [...new Set(Object.values(roles))].filter((c) => !live.has(c));
  if (missing.length > 0) throw new Error(`company ${COMPANY_ID} has no live account ${missing.join(', ')} — nothing to book on.`);
  return roles;
}

async function readPlan(db) {
  const [settings] = await db`SELECT deposit_cost_pct FROM scm.acc_company_settings WHERE company_id = ${COMPANY_ID}`;
  if (!settings) throw new Error(`company ${COMPANY_ID} has no settings row.`);
  const current = settings.deposit_cost_pct == null ? null : Number(settings.deposit_cost_pct);
  if (current != null && current !== PCT) throw new Error(`company ${COMPANY_ID} already books ${current}% — not ${PCT}%. Nothing was written.`);
  const rows = await db`
    SELECT d.di_number, d.amount_sen, d.je_no, d.invoice_date,
           EXISTS (SELECT 1 FROM scm.acc_credit_notes n
                    WHERE n.company_id = d.company_id AND n.kind = 'CN' AND n.source_doc_no = d.di_number
                      AND n.status <> 'CANCELLED') AS noted
      FROM scm.acc_deposit_invoices d
     WHERE d.company_id = ${COMPANY_ID} AND d.status = 'ISSUED' AND d.je_no IS NOT NULL
       AND COALESCE(d.cost_sen, 0) = 0 AND d.amount_sen > 0
     ORDER BY d.invoice_date, d.di_number`;
  return { current, take: rows.filter((r) => !r.noted), noted: rows.filter((r) => r.noted) };
}

// ── Plan ─────────────────────────────────────────────────────────────────────
const sql = postgres(process.env.DATABASE_URL, { max: CONCURRENCY + 2, prepare: false, types: DATE_AS_TEXT });
let plan, roles;
try {
  plan = await readPlan(sql);
  roles = await roleCodes(sql);
} catch (e) {
  await sql.end();
  stop(String(e?.message ?? e));
}
const id = planId(PCT, plan.take);
const byMonth = new Map();
for (const r of plan.take) {
  const m = String(r.invoice_date).slice(0, 7);
  byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
}
console.log(`Company ${COMPANY_ID}: books ${plan.current == null ? 'no deposit cost yet' : `${plan.current}%`}; to book ${PCT}%: ${plan.take.length} deposit invoice(s) to post again.`);
for (const [m, n] of [...byMonth].sort()) console.log(`  invoices of ${m}: ${n}`);
if (plan.noted.length > 0) console.log(`Left alone — a note already stands against them, ${plan.noted.length}: ${plan.noted.map((r) => r.di_number).join(', ')}`);
console.log(`Each: old entry reversed on its own day; new entry Dr ${roles.AR} / Cr ${roles.DEPOSIT_INCOME} + Dr ${roles.DEPOSIT_COST} / Cr ${roles.DEPOSIT_COST_ACCRUAL} for ${PCT}%. PLAN_ID ${id}`);

if (plan.take.length === 0 && plan.current === PCT) {
  await sql.end();
  console.log('Nothing to do.');
  process.exit(0);
}
if (!APPLY) {
  await sql.end();
  console.log(`\nPLAN only — nothing was written. To do it: MODE=apply, CONFIRM="${PHRASE}", PLAN_ID=${id}, the same PCT.`);
  process.exit(0);
}
if (PLAN_ID !== id) {
  await sql.end();
  stop(`PLAN_ID ${PLAN_ID} is not this plan (${id}): the invoices moved since it was read. Plan again. Nothing was written.`, 2);
}

// ── Apply ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
if (plan.current == null) {
  const set = await sql`UPDATE scm.acc_company_settings SET deposit_cost_pct = ${PCT}, updated_at = now(), updated_by = ${'Claude, for the owner (2026-11-26)'}
                         WHERE company_id = ${COMPANY_ID} AND deposit_cost_pct IS NULL RETURNING company_id`;
  if (set.length !== 1) { await sql.end(); stop(`the share was not set (${set.length} rows). Nothing else was written.`); }
  console.log(`Company ${COMPANY_ID} now books ${PCT}% of each deposit invoice as cost.`);
}
const done = [];
const skipped = [];
const failed = [];
let gap = null;
const queue = [...plan.take];
async function worker() {
  while (queue.length > 0 && !gap) {
    const r = queue.shift();
    const sb = pgrestShim(sql, 'scm');
    let res;
    try {
      res = await repostDepositInvoiceCost(sb, { companyId: COMPANY_ID, diNumber: r.di_number });
    } catch (e) {
      failed.push(`${r.di_number}: ${String(e?.message ?? e)}`);
      continue;
    }
    if (sb.__gaps.length > 0) { gap = `${r.di_number}: the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`; return; }
    if (!res.ok) failed.push(res.reason);
    else if (res.status === 'reposted') done.push({ di_number: r.di_number, oldJeNo: res.oldJeNo });
    else skipped.push(`${r.di_number}: ${res.why}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
await sql.end();
console.log(`\nPosted again with the cost: ${done.length}; left: ${skipped.length}; failed: ${failed.length}; ${secs(t0)}.`);
for (const s of skipped) console.log(`  LEFT ${s}`);
for (const f of failed) console.log(`  FAILED ${f}`);
if (gap) stop(`STOPPED: ${gap}`);

// ── Verify, on a FRESH connection ────────────────────────────────────────────
const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: DATE_AS_TEXT });
const problems = [];
try {
  const [settings] = await check`SELECT deposit_cost_pct FROM scm.acc_company_settings WHERE company_id = ${COMPANY_ID}`;
  if (Number(settings?.deposit_cost_pct) !== PCT) problems.push(`company ${COMPANY_ID} books ${settings?.deposit_cost_pct ?? 'no'}%, not ${PCT}%`);
  for (let i = 0; i < done.length; i += 500) {
    const part = done.slice(i, i + 500);
    const nos = part.map((d) => d.di_number);
    const dis = await check`
      SELECT di_number, amount_sen, cost_sen, je_no, invoice_date, party_code
        FROM scm.acc_deposit_invoices WHERE company_id = ${COMPANY_ID} AND di_number IN ${check(nos)}`;
    const entries = await check`
      SELECT id::text AS id, je_no, source_type, source_doc_no, reversed, posted, entry_date, reversed_by_je::text AS reversed_by_je
        FROM scm.journal_entries
       WHERE company_id = ${COMPANY_ID} AND source_type IN ('DI', 'DI_REVERSAL') AND source_doc_no IN ${check(nos)}`;
    const lines = await check`
      SELECT l.journal_entry_id::text AS journal_entry_id, l.account_code, l.debit_sen, l.credit_sen, l.party_code
        FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
       WHERE j.company_id = ${COMPANY_ID} AND j.source_type = 'DI' AND NOT COALESCE(j.reversed, FALSE) AND j.source_doc_no IN ${check(nos)}`;
    for (const d of part) {
      const di = dis.find((x) => x.di_number === d.di_number);
      if (!di) { problems.push(`${d.di_number}: not found`); continue; }
      problems.push(...repostProblems({ di, oldJeNo: d.oldJeNo, entries, lines, roles, pct: PCT }));
    }
  }
} finally {
  await check.end();
}
if (problems.length > 0) stop(`VERIFY FAILED after the run:\n  ${problems.join('\n  ')}`);
console.log(`Verified on a fresh connection: company ${COMPANY_ID} books ${PCT}%; ${done.length} deposit invoice(s) each on one standing entry with its cost, the old entry reversed on its own day.`);
if (failed.length > 0) process.exit(1);
