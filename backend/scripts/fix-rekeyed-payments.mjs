#!/usr/bin/env node
// fix-rekeyed-payments.mjs — money already recorded on a cancelled order was KEYED
// AGAIN on the order that replaced it, instead of moved by Convert; the copies have
// no bank or merchant line of their own and sit on Unmatched payments forever
// (owner 2026-11-02: 2990-SO-2607-027's RM 125 transfer + RM 1,933 PBB card are
// copies of 2990-SO-2606-001's, already reconciled there — 「做」).
//
// Through the app's own doors, exactly what Finance would press:
//   1. DELETE /mfg-sales-orders/:TO/payments/:id for each copy (deleteSoPaymentHandler:
//      its journal entry reversed, its receipt and deposit invoice follow, audit row
//      with the reason);
//   2. POST /mfg-sales-orders/:TO/payments { method: 'converted', convertedFromDocNo:
//      FROM, amountSen: Σ copies } (postSoPaymentHandler: convertGuard, the mirror on
//      FROM, its notes).
// Refuses unless every copy is on TO, is not converted, and has a twin on FROM with the
// same method, amount and approval code. Prints the two orders' payments, entries and
// receipts before and after.
//
// A copy dated in a CLOSED bank month refuses to move (the owner's lock). With
// UNLOCK=account:YYYY-MM (owner 2026-11-02: 开锁 HLB 6 月 → 改 → 锁回 —「做」) the month
// is released through POST /bank/months/:a/:m/unlock with UNLOCK_NOTE before the move,
// and closed again through POST /bank/months/:a/:m/lock after it — which refuses unless
// the month still tallies, so a month that would stay open makes the whole run fail
// and nothing is kept.
//
// PLAN by default: all of it inside one transaction, read back, ROLLED BACK.
// APPLY=1 with CONFIRM="MOVE RE-KEYED PAYMENTS" keeps it.
// Env: DATABASE_URL, COMPANY_ID, FROM_DOC, TO_DOC, PAYMENT_IDS (comma list), REASON, ACTOR,
//      UNLOCK (optional, account:YYYY-MM), UNLOCK_NOTE (with UNLOCK).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { deleteSoPaymentHandler, postSoPaymentHandler } from '../src/scm/routes/mfg-sales-orders.ts';
import { bankMonthLock, bankMonthUnlock } from '../src/scm/routes/accounting-bank-locks.ts';

const PHRASE = 'MOVE RE-KEYED PAYMENTS';
const APPLY = process.env.APPLY === '1';
if (APPLY && process.env.CONFIRM !== PHRASE) { console.error(`Refused: APPLY needs CONFIRM="${PHRASE}".`); process.exit(2); }
const CO = Number(process.env.COMPANY_ID);
const FROM = String(process.env.FROM_DOC ?? '').trim();
const TO = String(process.env.TO_DOC ?? '').trim();
const IDS = String(process.env.PAYMENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const REASON = String(process.env.REASON ?? '').trim();
const ACTOR = String(process.env.ACTOR ?? '').trim();
const UNLOCK = /^(d{3}-[A-Za-z0-9]{4}):(d{4}-d{2})$/.exec(String(process.env.UNLOCK ?? '').trim());
const UNLOCK_NOTE = String(process.env.UNLOCK_NOTE ?? '').trim();
if (process.env.UNLOCK && (!UNLOCK || !UNLOCK_NOTE)) { console.error('Refused: UNLOCK is account:YYYY-MM and needs UNLOCK_NOTE.'); process.exit(2); }
if (!Number.isInteger(CO) || !FROM || !TO || IDS.length === 0 || !REASON || !ACTOR) {
  console.error('Refused: COMPANY_ID, FROM_DOC, TO_DOC, PAYMENT_IDS, REASON and ACTOR are all required.');
  process.exit(2);
}

const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
class Rollback extends Error {}
/* Finance's rights for the two doors — the correction right opens a past payment. */
const PERMS = ['scm.so_payment.amend', 'scm.payment.backdate', 'scm.payment_voucher.post', 'scm.so.view_all',
  /* Reopening a closed bank month — only with UNLOCK. */
  ...(process.env.UNLOCK ? ['scm.payment_voucher.approve'] : [])];

async function snapshot(tx, label) {
  out(`== ${label}`);
  for (const doc of [FROM, TO]) {
    const pays = await tx`SELECT id, method, merchant_provider, online_type, amount_sen, approval_code, paid_at, note, converted_from_so_doc_no, converted_to_so_doc_no, mirror_of_payment_id
                            FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no = ${doc} ORDER BY paid_at, created_at`;
    const total = pays.reduce((s, p) => s + Number(p.amount_sen), 0);
    out(`  ${doc}: ${pays.length} payment(s), net RM ${rm(total)}`);
    for (const p of pays) {
      const jes = await tx`SELECT je_no, reversed FROM scm.journal_entries WHERE company_id = ${CO} AND source_type = 'SOPAY' AND source_doc_no = ${String(p.id)} ORDER BY id`;
      const ors = await tx`SELECT or_number, status FROM scm.acc_official_receipts WHERE company_id = ${CO} AND payment_source = 'SOPAY' AND payment_id = ${String(p.id)} ORDER BY id`;
      out(`    ${String(p.id).slice(0, 8)} ${p.method}${p.merchant_provider ? `/${p.merchant_provider}` : ''}${p.online_type ? `/${p.online_type}` : ''} RM ${rm(p.amount_sen)} ref ${p.approval_code ?? '—'} paid ${String(p.paid_at).slice(0, 10)}${p.note ? ` "${p.note}"` : ''} | JE ${jes.map((j) => `${j.je_no}${j.reversed ? ' (reversed)' : ''}`).join(', ') || '—'} | OR ${ors.map((o) => `${o.or_number} ${o.status}`).join(', ') || '—'}`);
    }
  }
  /* The copies themselves, gone or not: their entries (and any reversal of them) and receipts. */
  for (const id of IDS) {
    const jes = await tx`SELECT * FROM scm.journal_entries WHERE company_id = ${CO} AND source_doc_no = ${id} ORDER BY id`;
    const ors = await tx`SELECT or_number, status FROM scm.acc_official_receipts WHERE company_id = ${CO} AND payment_source = 'SOPAY' AND payment_id = ${id} ORDER BY id`;
    out(`  copy ${id.slice(0, 8)}: JE ${jes.map((j) => `${j.je_no} ${String(j.entry_date).slice(0, 10)} ${j.source_type}${j.reversed ? ' reversed' : ''}${j.reversal_of ? ` (reverses ${j.reversal_of})` : ''}`).join(', ') || '—'} | OR ${ors.map((o) => `${o.or_number} ${o.status}`).join(', ') || '—'}`);
    const rev = await tx`SELECT je_no, entry_date, source_type, source_doc_no FROM scm.journal_entries WHERE company_id = ${CO} AND (id::text IN (SELECT DISTINCT reversed_by_je::text FROM scm.v_gl_entries WHERE company_id = ${CO} AND reversed_by_je IS NOT NULL AND je_no IN (SELECT je_no FROM scm.journal_entries WHERE company_id = ${CO} AND source_doc_no = ${id})) OR je_no IN (SELECT DISTINCT reversed_by_je::text FROM scm.v_gl_entries WHERE company_id = ${CO} AND reversed_by_je IS NOT NULL AND je_no IN (SELECT je_no FROM scm.journal_entries WHERE company_id = ${CO} AND source_doc_no = ${id})))`;
    if (rev.length) out(`    reversal entries: ${rev.map((r) => `${r.je_no} ${String(r.entry_date).slice(0, 10)} ${r.source_type} ${r.source_doc_no}`).join(', ')}`);
  }
}

try {
  await sql.begin(async (tx) => {
    /* The guard: each id a copy of a payment still on FROM. */
    const copies = await tx`SELECT * FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND id::text = ANY(${IDS})`;
    if (copies.length !== IDS.length) throw new Error(`found ${copies.length} of ${IDS.length} payments`);
    for (const p of copies) {
      if (p.so_doc_no !== TO) throw new Error(`${p.id} is on ${p.so_doc_no}, not ${TO}`);
      if (p.method === 'converted' || Number(p.amount_sen) <= 0) throw new Error(`${p.id} is not a keyed payment`);
      const [twin] = await tx`SELECT id FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no = ${FROM}
                                AND method = ${p.method} AND amount_sen = ${p.amount_sen} AND approval_code IS NOT DISTINCT FROM ${p.approval_code}`;
      if (!twin) throw new Error(`${p.id} (RM ${rm(p.amount_sen)}, ${p.approval_code}) has no twin on ${FROM} — not a copy, nothing done`);
      out(`copy ${String(p.id).slice(0, 8)} RM ${rm(p.amount_sen)} ${p.method} ${p.approval_code} = ${FROM}'s ${String(twin.id).slice(0, 8)}`);
    }
    const moveSen = copies.reduce((s, p) => s + Number(p.amount_sen), 0);

    await snapshot(tx, 'BEFORE');

    const sb = pgrestShim(tx, 'scm');
    const ctx = (docNo, { id = null, query = {}, body, params = {} } = {}) => ({
      env: { DB: d1Compat(() => tx) },
      req: {
        param: (k) => ({ docNo, id, ...params })[k],
        query: (k) => query[k],
        json: async () => body,
        path: `/api/scm/mfg-sales-orders/${docNo}/payments${id ? `/${id}` : ''}`,
      },
      get: (k) => ({
        supabase: sb,
        companyId: CO,
        allowedCompanyIds: [CO],
        user: { id: '00000000-0000-4000-8000-000000000001', user_metadata: { name: ACTOR } },
        houzsUser: { name: ACTOR, permissions: PERMS, permissions_set: new Set(PERMS) },
      })[k],
      json: (b, status = 200) => ({ body: b, status }),
    });

    const lockOf = async () => (await tx`SELECT period_month, closing_statement_sen, closing_ledger_sen, difference_sen, locked_by, locked_at
                                             FROM scm.acc_bank_month_locks WHERE company_id = ${CO} AND account_code = ${UNLOCK[1]}
                                              AND period_month = ${UNLOCK[2] + '-01'}::date AND released_at IS NULL`)[0] ?? null;
    if (UNLOCK) {
      const was = await lockOf();
      out(`LOCK ${UNLOCK[1]} ${UNLOCK[2]} before: ${was ? `closed by ${was.locked_by} ${String(was.locked_at).slice(0, 10)} — statement ${rm(was.closing_statement_sen)} ledger ${rm(was.closing_ledger_sen)} difference ${rm(was.difference_sen)}` : 'NOT closed'}`);
      const res = await bankMonthUnlock(ctx('', { params: { accountCode: UNLOCK[1], month: UNLOCK[2] }, body: { note: UNLOCK_NOTE } }));
      out(`UNLOCK → ${res.status} ${res.status === 200 ? 'released' : JSON.stringify(res.body)}`);
      if (res.status !== 200) throw new Error(`unlock refused: ${JSON.stringify(res.body)}`);
    }
    for (const p of copies) {
      const res = await deleteSoPaymentHandler(ctx(TO, { id: String(p.id), query: { version: String(p.version ?? 1), reason: REASON } }));
      out(`DELETE ${String(p.id).slice(0, 8)} → ${res.status} ${JSON.stringify(res.body)}`);
      if (res.status !== 200) throw new Error(`delete refused: ${JSON.stringify(res.body)}`);
    }
    const add = await postSoPaymentHandler(ctx(TO, { body: { method: 'converted', convertedFromDocNo: FROM, amountSen: moveSen, paidAt: String(copies[0].paid_at).slice(0, 10), reason: REASON } }));
    out(`CONVERT RM ${rm(moveSen)} from ${FROM} → ${add.status} ${add.status === 201 ? `payment ${String(add.body.payment?.id ?? '').slice(0, 8)}` : JSON.stringify(add.body)}`);
    if (add.status !== 201) throw new Error(`convert refused: ${JSON.stringify(add.body)}`);
    if (UNLOCK) {
      const res = await bankMonthLock(ctx('', { params: { accountCode: UNLOCK[1], month: UNLOCK[2] }, body: {} }));
      out(`RELOCK → ${res.status} ${res.status === 200 ? 'closed again' : JSON.stringify(res.body)}`);
      if (res.status !== 200) throw new Error(`the month would not close again: ${JSON.stringify(res.body)}`);
      const now = await lockOf();
      out(`LOCK ${UNLOCK[1]} ${UNLOCK[2]} after: closed by ${now.locked_by} — statement ${rm(now.closing_statement_sen)} ledger ${rm(now.closing_ledger_sen)} difference ${rm(now.difference_sen)}`);
    }
    if (sb.__gaps.length > 0) throw new Error(`shim gaps: ${sb.__gaps.join(' | ')}`);

    await snapshot(tx, 'AFTER');
    if (!APPLY) throw new Rollback();
  });
  out('APPLIED — kept.');
} catch (e) {
  if (e instanceof Rollback) out('PLAN — ROLLED BACK, nothing was kept. Run with mode=apply and the CONFIRM phrase to keep it.');
  else { out(`FAILED: ${e?.message ?? e}`); process.exitCode = 1; }
} finally {
  await sql.end();
}
