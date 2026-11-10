#!/usr/bin/env node
// check-card-merchant-not-bank.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-10 (Payments not matched yet): 「如果merchant 对的上但bank 还有没有对的上要分开，会直接
// 不显示，因为可以是另外一笔卡着」 — card payments whose merchant report line is CONFIRMED (so the
// page counts them matched and hides them) but whose report's money has not reached a bank line
// yet, through the Cash Flow's own rule (acc/card-in-bank: merchantMatched, inBankShares), and why:
// the report still has other lines waiting (it is not offered to Bank Recon until every line is
// done), or the report is done and its bank credit is not matched yet.
// Env: DATABASE_URL, COMPANY_IDS (default "1,2"), FROM (default 180 days ago).
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { loadCardPayoutFacts, merchantMatched, inBankShares, paymentKey } from '../src/acc/card-in-bank.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const FROM = String(process.env.FROM || new Date(Date.parse(`${today}T00:00:00Z`) - 180 * 86_400_000).toISOString().slice(0, 10));
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    for (const CO of COS) {
      const f = await loadCardPayoutFacts(sb, CO);
      if (!f.ok) { row('FAILED', `co${CO}`, f.reason); continue; }
      const matched = merchantMatched(f.facts);
      const shares = inBankShares(f.facts, today);
      const batchOfRow = new Map(f.facts.rows.map((r) => [Number(r.id), Number(r.batch_id)]));
      const waitingByBatch = new Map();
      for (const r of await tx`SELECT batch_id, count(*)::int AS n FROM scm.acc_settlement_rows WHERE company_id = ${CO} AND confirmed_at IS NULL AND coalesce(bucket, '') <> 'IGNORED' GROUP BY 1`) waitingByBatch.set(Number(r.batch_id), r.n);
      const amounts = await tx`
        SELECT m.payment_source, m.payment_id::text AS payment_id, m.settlement_row_id, m.amount_sen,
               p.paid_at::date::text AS paid_on, p.so_doc_no
          FROM scm.acc_settlement_matches m
          LEFT JOIN scm.mfg_sales_order_payments p ON m.payment_source = 'SOPAY' AND p.id::text = m.payment_id::text
         WHERE m.company_id = ${CO}`;
      const tally = new Map();
      const add = (k, sen) => { const x = tally.get(k) ?? { n: 0, sen: 0 }; x.n += 1; x.sen += Number(sen ?? 0); tally.set(k, x); };
      const batchesHeld = new Set(); const batchesWaitingBank = new Set();
      for (const a of amounts) {
        const key = paymentKey(a.payment_source, a.payment_id);
        if (!matched.has(key)) continue;
        if (a.paid_on && a.paid_on < FROM) continue;
        const share = shares.get(key) ?? 0;
        if (share >= 1) { add('merchant matched AND in the bank', a.amount_sen); continue; }
        const batch = batchOfRow.get(Number(a.settlement_row_id));
        const waiting = waitingByBatch.get(batch) ?? 0;
        if (waiting > 0) { add('merchant matched, bank not yet — its report has other lines waiting', a.amount_sen); batchesHeld.add(batch); }
        else { add(`merchant matched, bank not yet — report done, ${share > 0 ? 'bank paid part' : 'bank credit not matched'}`, a.amount_sen); batchesWaitingBank.add(batch); }
      }
      for (const [k, x] of [...tally].sort()) row('CARD', `co${CO}`, `paid from ${FROM}`, k, x.n, `RM ${rm(x.sen)}`);
      row('REPORTS', `co${CO}`, `held by waiting lines ${batchesHeld.size}`, `done, bank not matched ${batchesWaitingBank.size}`);
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
