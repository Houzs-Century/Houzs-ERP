#!/usr/bin/env node
// fix-receipts-follow-payments.mjs — receipts left saying what their payment no
// longer says (owner 2026-10-29: 收据跟着付款改或作废 —「做」, and the three of
// 2990's October check fixed the same way: 2990-HOR-2610-021, 2990-COR-2610-003,
// 2990-HOR-2610-039).
//
// HOW. The app's own code, driven over DATABASE_URL through lib/pgrest-shim.mjs —
// exactly what an edit or a delete of the payment now does to its receipt:
//   - the payment is still there, its amount / day / method moved →
//     acc/receipts.ts followPaymentEdit with the payment as it now stands: a draft
//     rewritten in place; a formal receipt CANCELLED (reason, who, successor) and
//     re-issued — formal at once on the same channel when the method is unchanged;
//   - the payment is gone → followPaymentRemoval: a draft removed, a formal
//     receipt CANCELLED and kept.
// With ORS (comma list of OR numbers) only those receipts are touched; with none
// the script LISTS every live receipt of the company whose payment moved or went,
// and writes nothing (MODE=apply refuses without ORS).
//
// MODE=plan (the default) runs everything in ONE transaction and rolls it back,
// printing what each receipt became and the month checks after; MODE=apply with
// CONFIRM="FIX RECEIPTS TO THEIR PAYMENTS" keeps it, then re-reads on a FRESH
// connection: each named receipt cancelled or matching, its payment's live receipt
// saying what the payment says, and each touched month's check — payments against
// receipts — printed.
//
// Dates: the connection reads date/timestamp columns as text, the way PostgREST
// hands them to the app code.
//
// Env: DATABASE_URL, COMPANY_ID, ORS.
//   COMPANY_ID=2 ORS=2990-HOR-2610-021,2990-COR-2610-003,2990-HOR-2610-039 npx tsx scripts/fix-receipts-follow-payments.mjs
//   ... MODE=apply CONFIRM="FIX RECEIPTS TO THEIR PAYMENTS" ...

import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { followPaymentEdit, followPaymentRemoval, receiptChange } from '../src/acc/receipts.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'FIX RECEIPTS TO THEIR PAYMENTS';
const COMPANY_ID = Number(process.env.COMPANY_ID || 0);
const ORS = String(process.env.ORS || '').split(',').map((s) => s.trim()).filter(Boolean);
const WHO = 'Receipt follows its payment (owner 2026-10-29)';
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const DB_OPTIONS = { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } };

const stop = (msg, code = 1) => { console.error(msg); process.exit(code); };
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set.', 2);
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) stop('COMPANY_ID is required.', 2);
if (APPLY && ORS.length === 0) stop('MODE=apply needs ORS — the receipts the owner named. Nothing was written.', 2);
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) stop(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`, 2);

const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v) => String(v ?? '').slice(0, 10);
const out = (s) => console.log(`ROW|${s}`);
class Rollback extends Error {}

/** Every live receipt of the company, beside its payment as it now stands. */
async function receiptsWithPayments(db, orNumbers) {
  const rows = await db`
    SELECT r.id, r.or_number, r.status, r.payment_source, r.payment_id, r.doc_no, r.amount_sen, r.paid_at, r.method,
           r.channel_account_code,
           COALESCE(so.id::text, si.id::text) AS pay_id,
           COALESCE(so.amount_sen, si.amount_sen) AS pay_sen,
           COALESCE(so.paid_at::text, si.paid_at::text) AS pay_at,
           COALESCE(so.method, si.method) AS pay_method
      FROM scm.acc_official_receipts r
      LEFT JOIN scm.mfg_sales_order_payments so ON r.payment_source = 'SOPAY' AND so.id::text = r.payment_id
      LEFT JOIN scm.sales_invoice_payments si ON r.payment_source = 'SIPAY' AND si.id::text = r.payment_id
     WHERE r.company_id = ${COMPANY_ID} AND r.status <> 'CANCELLED'
       AND (${orNumbers.length === 0} OR r.or_number = ANY(${orNumbers}))
     ORDER BY r.paid_at, r.or_number`;
  return rows.map((r) => {
    const gone = r.pay_id == null;
    const change = gone ? 'payment gone' : receiptChange(r, { amountSen: Number(r.pay_sen), paidAt: day(r.pay_at), method: String(r.pay_method ?? '') });
    return { ...r, gone, change };
  });
}

/** One month's check, the way GET /accounting/receipts/check reads it. */
async function monthCheck(db, month) {
  const from = `${month}-01`;
  const [{ to }] = await db`SELECT (date_trunc('month', ${from}::date) + interval '1 month - 1 day')::date::text AS to`;
  const [p] = await db`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_sen), 0)::bigint AS sen FROM (
      SELECT amount_sen, method FROM scm.mfg_sales_order_payments WHERE company_id = ${COMPANY_ID} AND paid_at::date BETWEEN ${from}::date AND ${to}::date
      UNION ALL
      SELECT amount_sen, method FROM scm.sales_invoice_payments WHERE company_id = ${COMPANY_ID} AND paid_at::date BETWEEN ${from}::date AND ${to}::date
    ) x WHERE method IS DISTINCT FROM 'converted' AND amount_sen > 0`;
  const [r] = await db`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_sen), 0)::bigint AS sen FROM scm.acc_official_receipts
     WHERE company_id = ${COMPANY_ID} AND status <> 'CANCELLED' AND paid_at BETWEEN ${from}::date AND ${to}::date`;
  return { month, payments: { n: p.n, sen: Number(p.sen) }, receipts: { n: r.n, sen: Number(r.sen) }, diff: Number(p.sen) - Number(r.sen) };
}

const printCheck = (c) => out(`check ${c.month}: payments ${rm(c.payments.sen)} (${c.payments.n}) · receipts ${rm(c.receipts.sen)} (${c.receipts.n}) · difference ${rm(c.diff)}`);

/** What each named receipt must look like now — as values. */
async function shapeProblems(db, targets) {
  const p = [];
  for (const t of targets) {
    const [old] = await db`SELECT status, cancel_reason, replaced_by_id FROM scm.acc_official_receipts WHERE company_id = ${COMPANY_ID} AND id = ${t.id}`;
    const [live] = await db`
      SELECT or_number, status, amount_sen, paid_at::text AS paid_at, method, channel_account_code FROM scm.acc_official_receipts
       WHERE company_id = ${COMPANY_ID} AND payment_source = ${t.payment_source} AND payment_id = ${t.payment_id} AND status <> 'CANCELLED'`;
    if (t.gone) {
      if (t.status === 'FORMAL' && old?.status !== 'CANCELLED') p.push(`${t.or_number}: reads ${old?.status}, expected CANCELLED`);
      if (t.status !== 'FORMAL' && old) p.push(`${t.or_number}: the draft is still there`);
      if (live) p.push(`${t.or_number}: the deleted payment still has a live receipt ${live.or_number}`);
      continue;
    }
    if (!live) { p.push(`${t.or_number}: its payment has no live receipt`); continue; }
    if (Number(live.amount_sen) !== Number(t.pay_sen) || day(live.paid_at) !== day(t.pay_at) || String(live.method ?? '') !== String(t.pay_method ?? '')) {
      p.push(`${t.or_number}: the live receipt ${live.or_number} reads ${rm(live.amount_sen)} ${day(live.paid_at)} ${live.method}, the payment ${rm(t.pay_sen)} ${day(t.pay_at)} ${t.pay_method}`);
    }
    if (t.status === 'FORMAL') {
      if (old?.status !== 'CANCELLED') p.push(`${t.or_number}: reads ${old?.status}, expected CANCELLED`);
      if (String(t.method ?? '') === String(t.pay_method ?? '') && (live.status !== 'FORMAL' || live.channel_account_code !== t.channel_account_code)) {
        p.push(`${t.or_number}: its successor ${live.or_number} is ${live.status} on ${live.channel_account_code}, expected FORMAL on ${t.channel_account_code}`);
      }
    }
  }
  return p;
}

const sql = postgres(process.env.DATABASE_URL, DB_OPTIONS);
out(`mode ${APPLY ? 'APPLY' : 'plan (rolled back)'}, company ${COMPANY_ID}, ${ORS.length > 0 ? ORS.join(', ') : 'every receipt (list only)'}`);
let targets = [];
try {
  await sql.begin(async (tx) => {
    const all = await receiptsWithPayments(tx, ORS);
    targets = all.filter((r) => r.change);
    if (ORS.length > 0) {
      const found = new Set(all.map((r) => r.or_number));
      const missing = ORS.filter((o) => !found.has(o));
      if (missing.length > 0) throw new Error(`not a live receipt of company ${COMPANY_ID}: ${missing.join(', ')}`);
      const fine = all.filter((r) => !r.change).map((r) => r.or_number);
      if (fine.length > 0) throw new Error(`already say what their payment says: ${fine.join(', ')}`);
    }
    for (const t of targets) {
      out(`${t.or_number} ${t.status} ${t.doc_no ?? '-'} ${rm(t.amount_sen)} ${day(t.paid_at)} ${t.method} — ${t.gone ? 'payment gone' : `payment now ${rm(t.pay_sen)} ${day(t.pay_at)} ${t.pay_method}: ${t.change}`}`);
    }
    out(`${targets.length} receipt(s) no longer say what their payment says`);
    if (ORS.length === 0) throw new Rollback('list');

    const sb = pgrestShim(tx, 'scm');
    const months = new Set();
    for (const t of targets) {
      months.add(day(t.paid_at).slice(0, 7));
      if (!t.gone) months.add(day(t.pay_at).slice(0, 7));
    }
    const before = [];
    for (const m of [...months].sort()) before.push(await monthCheck(tx, m));
    for (const t of targets) {
      const r = t.gone
        ? await followPaymentRemoval(sb, { source: t.payment_source, paymentId: t.payment_id, companyId: COMPANY_ID, why: `Payment on ${t.doc_no ?? 'the order'} deleted`, actor: WHO })
        : await followPaymentEdit(sb, {
          source: t.payment_source, paymentId: t.payment_id, companyId: COMPANY_ID,
          next: { amountSen: Number(t.pay_sen), paidAt: day(t.pay_at), method: String(t.pay_method ?? '') },
          why: `Payment on ${t.doc_no ?? 'the order'} changed`, actor: WHO,
        });
      if (!r.ok) throw new Error(`${t.or_number}: ${r.reason}`);
      out(`${t.or_number} → ${r.touch ? (r.touch.draft ? 'draft removed' : `CANCELLED${r.touch.to ? `, re-issued as ${r.touch.to}` : ''}`) : 'followed in place'}`);
    }
    if (sb.__gaps.length > 0) throw new Error(`the shim met a method it does not implement: ${sb.__gaps.join(' | ')}`);
    const inside = await shapeProblems(tx, targets);
    if (inside.length > 0) throw new Error(`the result is not the expected shape:\n  ${inside.join('\n  ')}`);
    for (const c of before) out(`before — ${c.month}: difference ${rm(c.diff)}`);
    for (const m of [...months].sort()) printCheck(await monthCheck(tx, m));
    if (!APPLY) throw new Rollback('plan');
  });
} catch (e) {
  await sql.end();
  if (e instanceof Rollback) {
    out(e.message === 'list' ? 'LIST only — nothing written.' : 'PLAN — every check passed; rolled back, nothing written. Re-run with MODE=apply and the CONFIRM phrase.');
    process.exit(0);
  }
  stop(`ROLLED BACK — nothing was written. ${String(e?.message ?? e)}`);
}
await sql.end();

// ── Verify, on a FRESH connection ────────────────────────────────────────────
const check = postgres(process.env.DATABASE_URL, DB_OPTIONS);
try {
  const problems = await shapeProblems(check, targets);
  if (problems.length > 0) stop(`VERIFY FAILED after commit:\n  ${problems.join('\n  ')}`);
  const months = new Set();
  for (const t of targets) { months.add(day(t.paid_at).slice(0, 7)); if (!t.gone) months.add(day(t.pay_at).slice(0, 7)); }
  for (const m of [...months].sort()) printCheck(await monthCheck(check, m));
  const rows = await check`
    SELECT or_number, status, amount_sen, paid_at::text AS paid_at, cancel_reason FROM scm.acc_official_receipts
     WHERE company_id = ${COMPANY_ID} AND payment_id = ANY(${targets.map((t) => t.payment_id)}) ORDER BY payment_id, id`;
  for (const r of rows) out(`now ${r.or_number} ${r.status} ${rm(r.amount_sen)} ${day(r.paid_at)}${r.cancel_reason ? ` — ${r.cancel_reason}` : ''}`);
} finally {
  await check.end();
}
out(`APPLIED — ${targets.length} receipt(s) follow their payments, verified on a fresh connection.`);
