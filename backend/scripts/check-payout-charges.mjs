#!/usr/bin/env node
// check-payout-charges.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-10 on 2990-SO-2606-005 ("the bank has paid 90% of" PBB's 06/06 report):
// 「我记得那时我处理完了啊」. A charge booked on an advice day (acc_settlement_payout_batches
// .charge_sen, the RM 324 "application fees" of 2026-09-10, acc/payout-charge.ts) — is it
// there for report 9, and how many reports read short only because card-in-bank's
// inBankShares counts the receipts' own charge but not the advice day's?
// Prints ids, dates, shares (%) and yes/no only — this repository's Actions logs are public.
// Env: DATABASE_URL, BATCH_ID (default 9), COMPANY_ID (default 2).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 2);
const BATCH = Number(process.env.BATCH_ID || 9);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const yn = (b) => (b ? 'yes' : 'no');
const N = (v) => Number(v ?? 0);
const pct = (got, due) => (due > 0 ? `${Math.round((got / due) * 1000) / 10}%` : 'nothing owed');

try {
  await sql.begin('read only', async (tx) => {
    const days = await tx`SELECT d.id, d.payout_id, d.company_id, d.settled_on::text AS d, d.batch_id, d.net_sen, to_jsonb(d) AS j
      FROM scm.acc_settlement_payout_batches d WHERE d.batch_id = ${BATCH} AND d.company_id = ${CO} ORDER BY d.id`;
    const [b] = await tx`SELECT id, acquirer_code, to_jsonb(b) AS j FROM scm.acc_settlement_batches b WHERE id = ${BATCH} AND company_id = ${CO}`;
    const payable = N(b?.j.stated_net_sen ?? b?.j.net_sen);
    const rs = await tx`SELECT amount_sen, coalesce((to_jsonb(r)->>'charge_sen')::bigint, 0) AS charge_sen, je_no FROM scm.acc_settlement_receipts r WHERE batch_id = ${BATCH} AND company_id = ${CO}`;
    const received = rs.filter((r) => r.je_no).reduce((s, r) => s + N(r.amount_sen) + N(r.charge_sen), 0);
    for (const d of days) {
      const charge = N(d.j.charge_sen);
      row('ADVICE_DAY', `day row ${d.id}`, `advice ${d.payout_id}`, `settled ${d.d}`, `report ${d.batch_id}`,
        `charge booked ${yn(charge > 0)}`, `charge posted ${yn(Boolean(d.j.charge_je_no))}`, `account ${d.j.charge_account_code ?? '—'}`,
        `report = advice day + charge ${yn(N(d.net_sen) + charge === payable)}`, `receipts + charge cover the report ${yn(received + charge >= payable)}`,
        `receipts alone ${pct(received, payable)}`, `with the charge ${pct(received + charge, payable)}`);
    }
    if (days.length === 0) row('ADVICE_DAY', `report ${BATCH}`, 'no advice day row');

    /* Every report of both companies: short on its receipts, whole once its advice days' posted charges are counted. */
    for (const co of [1, 2]) {
      const all = await tx`SELECT b.id, to_jsonb(b) AS j,
          coalesce((SELECT sum(r.amount_sen + coalesce((to_jsonb(r)->>'charge_sen')::bigint, 0)) FROM scm.acc_settlement_receipts r WHERE r.batch_id = b.id AND r.je_no IS NOT NULL), 0)::bigint AS got,
          coalesce((SELECT sum((to_jsonb(d)->>'charge_sen')::bigint) FROM scm.acc_settlement_payout_batches d WHERE d.batch_id = b.id AND (to_jsonb(d)->>'charge_je_no') IS NOT NULL), 0)::bigint AS day_charge
        FROM scm.acc_settlement_batches b WHERE b.company_id = ${co}`;
      let charged = 0; let shortOnReceipts = 0; let wholeWithCharge = 0;
      for (const x of all) {
        const due = N(x.j.stated_net_sen ?? x.j.net_sen);
        const got = N(x.got); const ch = N(x.day_charge);
        if (ch > 0) charged += 1;
        if (got > 0 && got < due) {
          shortOnReceipts += 1;
          if (ch > 0 && got + ch >= due) { wholeWithCharge += 1; row('WHOLE_WITH_DAY_CHARGE', `co${co}`, `report ${x.id}`, `receipts alone ${pct(got, due)}`, `with the charge ${pct(got + ch, due)}`); }
        }
      }
      row('COMPANY', `co${co}`, `reports ${all.length}`, `with a posted advice-day charge ${charged}`, `paid in part on receipts alone ${shortOnReceipts}`, `of those, whole once the day's charge counts ${wholeWithCharge}`);
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
