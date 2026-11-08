#!/usr/bin/env node
// check-pv-listing-today.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// What the new Payment listing will show on 2026-11-08 by default: every voucher Prepared
// or Checked (DRAFT with submitted_at), dated up to today, per company; how many find a bank
// through their payment request or their supplier (the listing's fallback for vouchers made
// before the bank fields), and which find none.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const has = (...v) => v.some((x) => String(x ?? '').trim() !== '');

await sql.begin('READ ONLY', async (tx) => {
  const vs = await tx`
    SELECT v.company_id, v.id::text AS id, v.pv_number, v.payee_name, v.voucher_date, v.total_sen, v.currency, v.exchange_rate,
           v.checked_at, v.notes, s.bank_name AS s_bank, s.bank_account_no AS s_no, s.bank_account_name AS s_name
      FROM scm.payment_vouchers v LEFT JOIN scm.suppliers s ON s.id = v.supplier_id
     WHERE v.status = 'DRAFT' AND v.submitted_at IS NOT NULL AND v.voucher_date <= '2026-11-08'
     ORDER BY v.company_id, v.voucher_date, v.pv_number`;
  const ids = vs.map((v) => v.id);
  const rq = ids.length ? await tx`
    SELECT pv_id::text AS pv_id, request_no, bank_name, bank_account_no, bank_account_name
      FROM scm.acc_payment_requests WHERE pv_id::text IN ${tx(ids)}` : [];
  const reqOf = new Map();
  for (const r of rq) reqOf.set(r.pv_id, [...(reqOf.get(r.pv_id) ?? []), r]);
  for (const co of [...new Set(vs.map((v) => v.company_id))]) {
    const mine = vs.filter((v) => v.company_id === co);
    const myr = (v) => Math.round(Number(v.total_sen) * (String(v.currency ?? 'MYR').toUpperCase() === 'MYR' ? 1 : Number(v.exchange_rate) || 1));
    const via = (v) => {
      const asked = (reqOf.get(v.id) ?? []).filter((r) => has(r.bank_name, r.bank_account_no, r.bank_account_name));
      if (asked.length > 0) return 'request';
      if (has(v.s_bank, v.s_no, v.s_name)) return 'supplier';
      return 'none';
    };
    const count = (k) => mine.filter((v) => via(v) === k).length;
    const bankInNotes = mine.filter((v) => /pay to/i.test(String(v.notes ?? ''))).length;
    out(`company ${co}: ${mine.length} vouchers, RM ${rm(mine.reduce((s, v) => s + myr(v), 0))} | Prepared ${mine.filter((v) => !v.checked_at).length}, Checked ${mine.filter((v) => v.checked_at).length} | bank via request ${count('request')}, via supplier ${count('supplier')}, none ${count('none')} | old "pay to" text in notes ${bankInNotes}`);
    for (const v of mine.filter((x) => via(x) === 'none')) out(`   no bank: ${v.pv_number} ${v.voucher_date} ${v.payee_name} RM ${rm(myr(v))} ${v.checked_at ? 'Checked' : 'Prepared'}`);
  }
});
await sql.end();
