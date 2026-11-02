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
// PLAN by default: all of it inside one transaction, read back, ROLLED BACK.
// APPLY=1 with CONFIRM="MOVE RE-KEYED PAYMENTS" keeps it.
// Env: DATABASE_URL, COMPANY_ID, FROM_DOC, TO_DOC, PAYMENT_IDS (comma list), REASON, ACTOR.
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { deleteSoPaymentHandler, postSoPaymentHandler } from '../src/scm/routes/mfg-sales-orders.ts';

const PHRASE = 'MOVE RE-KEYED PAYMENTS';
const APPLY = process.env.APPLY === '1';
if (APPLY && process.env.CONFIRM !== PHRASE) { console.error(`Refused: APPLY needs CONFIRM="${PHRASE}".`); process.exit(2); }
const CO = Number(process.env.COMPANY_ID);
const FROM = String(process.env.FROM_DOC ?? '').trim();
const TO = String(process.env.TO_DOC ?? '').trim();
const IDS = String(process.env.PAYMENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const REASON = String(process.env.REASON ?? '').trim();
const ACTOR = String(process.env.ACTOR ?? '').trim();
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
const PERMS = ['scm.so_payment.amend', 'scm.payment.backdate', 'scm.payment_voucher.post', 'scm.sales_order.view_all'];

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
    const ctx = (docNo, { id = null, query = {}, body } = {}) => ({
      env: { DB: d1Compat(() => tx) },
      req: {
        param: (k) => ({ docNo, id })[k],
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

    for (const p of copies) {
      const res = await deleteSoPaymentHandler(ctx(TO, { id: String(p.id), query: { version: String(p.version ?? 1), reason: REASON } }));
      out(`DELETE ${String(p.id).slice(0, 8)} → ${res.status} ${JSON.stringify(res.body)}`);
      if (res.status !== 200) throw new Error(`delete refused: ${JSON.stringify(res.body)}`);
    }
    const add = await postSoPaymentHandler(ctx(TO, { body: { method: 'converted', convertedFromDocNo: FROM, amountSen: moveSen, paidAt: String(copies[0].paid_at).slice(0, 10), reason: REASON } }));
    out(`CONVERT RM ${rm(moveSen)} from ${FROM} → ${add.status} ${add.status === 201 ? `payment ${String(add.body.payment?.id ?? '').slice(0, 8)}` : JSON.stringify(add.body)}`);
    if (add.status !== 201) throw new Error(`convert refused: ${JSON.stringify(add.body)}`);
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
