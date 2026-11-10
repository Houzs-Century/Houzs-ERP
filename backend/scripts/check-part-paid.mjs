#!/usr/bin/env node
// check-part-paid.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-10, Payments not matched yet: 2990-SO-2606-005 (card · PBB, 12/06) "Merchant
// matched — the bank has paid 90% of 2990HOMESB_CSV_202606…" 「这笔是什么情况？」. Which report,
// which bank credits paid it and how much of it (as a share), where the rest went: a credit
// split over several reports, a neighbour report paid more than it was owed, or a report
// whose own total disagrees with its lines.
// Prints ids, dates, shares (%) and yes/no only — this repository's Actions logs are public.
// Env: DATABASE_URL, COMPANY_ID (default 2), SO (default 2990-SO-2606-005).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 2);
const SO = String(process.env.SO || '2990-SO-2606-005');
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const yn = (b) => (b ? 'yes' : 'no');
const pct = (got, due) => (Number(due) > 0 ? `${Math.round((Number(got) / Number(due)) * 1000) / 10}%` : 'no amount owed');
const N = (v) => Number(v ?? 0);

try {
  await sql.begin('read only', async (tx) => {
    const payable = (b) => N(b.j.stated_net_sen ?? b.j.net_sen);
    const batchOf = async (id) => (await tx`SELECT id, acquirer_code, period_from::text AS pf, period_to::text AS pt, to_jsonb(b) AS j FROM scm.acc_settlement_batches b WHERE company_id = ${CO} AND id = ${id}`)[0];
    const receiptsOf = (id) => tx`SELECT id, received_on::text AS d, amount_sen, coalesce((to_jsonb(r)->>'charge_sen')::bigint, 0) AS charge_sen, je_no FROM scm.acc_settlement_receipts r WHERE company_id = ${CO} AND batch_id = ${id} ORDER BY received_on, id`;
    const gotOf = (rs) => rs.filter((r) => r.je_no).reduce((s, r) => s + N(r.amount_sen) + N(r.charge_sen), 0);

    /* The order's payments and the report lines that claim them. */
    const pays = await tx`SELECT p.id::text AS id, p.paid_at::date::text AS d, to_jsonb(p)->>'method' AS method FROM scm.mfg_sales_order_payments p WHERE p.so_doc_no = ${SO} ORDER BY p.paid_at`;
    const batches = new Set();
    for (const p of pays) {
      const claims = await tx`SELECT m.settlement_row_id AS rid, r.batch_id, r.txn_date::text AS d, r.confirmed_at IS NOT NULL AS confirmed
        FROM scm.acc_settlement_matches m JOIN scm.acc_settlement_rows r ON r.id = m.settlement_row_id
        WHERE m.company_id = ${CO} AND m.payment_id = ${p.id}`;
      row('PAYMENT', p.id.slice(0, 8), p.d, `method ${p.method ?? '?'}`, claims.map((c) => `report line ${c.rid} of report ${c.batch_id} (${c.d}) confirmed ${yn(c.confirmed)}`).join(' ; ') || 'claimed by no report line');
      for (const c of claims) batches.add(Number(c.batch_id));
    }

    for (const id of batches) {
      const b = await batchOf(id);
      const lines = await tx`SELECT count(*)::int AS n, count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed,
          count(*) FILTER (WHERE net_sen < 0)::int AS negative, coalesce(sum(net_sen), 0)::bigint AS net, count(DISTINCT txn_date)::int AS days,
          min(txn_date)::text AS first_day, max(txn_date)::text AS last_day FROM scm.acc_settlement_rows WHERE batch_id = ${id}`;
      const l = lines[0];
      const rs = await receiptsOf(id);
      row('REPORT', `report ${id}`, `acquirer ${b.acquirer_code}`, `period ${b.pf}..${b.pt}`, `trading days ${l.first_day}..${l.last_day} (${l.days})`, `lines ${l.n}, confirmed ${l.confirmed}, negative ${l.negative}`,
        `stated total given ${yn(b.j.stated_net_sen != null)}`, `lines add up to the total it is owed ${yn(N(l.net) === payable(b))}`, `lines are ${pct(l.net, payable(b))} of it`,
        `bank paid ${pct(gotOf(rs), payable(b))}`, `credits ${rs.length}`);
      const holders = new Map();
      for (const r of rs) {
        const lns = r.je_no ? await tx`SELECT l.id, l.booked_on::text AS d, l.state, l.posted_je_no, l.amount_sen FROM scm.acc_bank_statement_lines l WHERE l.company_id = ${CO} AND l.posted_je_no LIKE ${'%' + r.je_no + '%'}` : [];
        row('CREDIT', `credit ${r.id}`, r.d, `posted ${yn(r.je_no)}`, `is ${pct(N(r.amount_sen) + N(r.charge_sen), payable(b))} of the report`, `charge kept ${yn(N(r.charge_sen) !== 0)}`,
          lns.map((x) => `bank line ${x.id} ${x.d} ${x.state} entries ${String(x.posted_je_no ?? '').split(',').filter(Boolean).length}`).join(' ; ') || 'on no bank line');
        for (const x of lns) holders.set(Number(x.id), x);
      }
      /* What each bank line that paid this report paid in all, and to which reports. */
      for (const x of holders.values()) {
        const jes = String(x.posted_je_no ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const parts = jes.length ? await tx`SELECT batch_id, amount_sen, coalesce((to_jsonb(r)->>'charge_sen')::bigint, 0) AS charge_sen FROM scm.acc_settlement_receipts r WHERE company_id = ${CO} AND je_no IN ${tx(jes)}` : [];
        const paid = parts.reduce((s, p) => s + N(p.amount_sen), 0);
        row('BANK_LINE', `bank line ${x.id}`, x.d, `pays reports ${[...new Set(parts.map((p) => p.batch_id))].join(',') || '—'}`, `its amount equals what those credits say ${yn(paid === N(x.amount_sen))}`);
        for (const other of new Set(parts.map((p) => Number(p.batch_id)))) {
          if (other === id) continue;
          const ob = await batchOf(other);
          row('ALSO_PAYS', `report ${other}`, `period ${ob.pf}..${ob.pt}`, `bank paid ${pct(gotOf(await receiptsOf(other)), payable(ob))}`);
        }
      }
      /* The same acquirer's reports a week either side: one paid more than it was owed holds this one's rest. */
      const near = await tx`SELECT id, period_from::text AS pf, period_to::text AS pt, to_jsonb(b) AS j FROM scm.acc_settlement_batches b
        WHERE company_id = ${CO} AND acquirer_code = ${b.acquirer_code} AND id <> ${id}
          AND period_from BETWEEN (${b.pf}::date - 7) AND (${b.pt}::date + 7) ORDER BY period_from, id`;
      for (const o of near) row('NEAR', `report ${o.id}`, `period ${o.pf}..${o.pt}`, `bank paid ${pct(gotOf(await receiptsOf(o.id)), payable(o))}`);
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
