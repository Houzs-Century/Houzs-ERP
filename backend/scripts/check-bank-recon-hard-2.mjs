#!/usr/bin/env node
// check-bank-recon-hard-2.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-10 「为何我感觉现在的bank recon 很难对账啊？」 — the follow-up reads for
// Houzs (company 1), whose Maybank months carry most of the open lines:
//  1. every statement filed, per account (is a month missing?);
//  2. the card reports on Merchant Recon, per acquirer (can the card credits pair?);
//  3. the open lines by kind and note;
//  4. each open money-in line with no entry: an SO payment of the same amount within
//     10 days in EITHER company, its customer, method and where its money leg went;
//     and whether a same-amount entry further away is the same customer.
// Env: DATABASE_URL, COMPANY_ID (default 1), ACCOUNT (default 310-0010).
import postgres from 'postgres';
import { namesAgree } from '../src/acc/bank-match.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 1);
const ACCOUNT = String(process.env.ACCOUNT || '310-0010');
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d10 = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const head = (t) => console.log(`\n=== ${t}`);
const gap = (a, b) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const short = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

try {
  await sql.begin('read only', async (tx) => {
    head(`1. statements filed, company ${CO}`);
    for (const s of await tx`
      SELECT s.id, s.account_code, s.file_name, s.period_from::text AS f, s.period_to::text AS t, s.created_at,
             (SELECT count(*)::int FROM scm.acc_bank_statement_lines l WHERE l.statement_id = s.id) AS n
        FROM scm.acc_bank_statements s WHERE s.company_id = ${CO} ORDER BY s.account_code, s.period_from`) {
      row('FILE', s.account_code, `st${s.id}`, `${s.f}..${s.t}`, `lines ${s.n}`, short(s.file_name, 70), `uploaded ${d10(s.created_at)}`);
    }
    for (const m of await tx`
      SELECT account_code, to_char(entry_date, 'YYYY-MM') AS m, count(DISTINCT je_no)::int AS n
        FROM scm.v_gl_entries WHERE company_id = ${CO} AND account_code LIKE '310-%' AND entry_date >= '2026-09-01'
       GROUP BY 1, 2 ORDER BY 1, 2`) {
      row('BOOKS', m.account_code, m.m, `entries ${m.n}`);
    }

    head(`2. card reports on Merchant Recon, company ${CO}`);
    for (const b of await tx`
      SELECT to_jsonb(b) AS j FROM scm.acc_settlement_batches b WHERE b.company_id = ${CO} ORDER BY b.id DESC LIMIT 3`) {
      row('BATCH_SHAPE', Object.keys(b.j).join(','));
    }
    for (const b of await tx`
      SELECT to_jsonb(b)->>'acquirer_code' AS acq, count(*)::int AS n,
             min(to_jsonb(b)->>'trading_date') AS first, max(to_jsonb(b)->>'trading_date') AS last
        FROM scm.acc_settlement_batches b WHERE b.company_id = ${CO} GROUP BY 1 ORDER BY 1`) {
      row('BATCHES', b.acq ?? '—', `reports ${b.n}`, `${b.first ?? '?'}..${b.last ?? '?'}`);
    }

    head(`3. open lines of company ${CO} by account, kind and note`);
    for (const g of await tx`
      SELECT s.account_code, l.kind, left(coalesce(l.note, ''), 90) AS note, count(*)::int AS n, sum(l.amount_sen)::bigint AS sen
        FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
       WHERE l.company_id = ${CO} AND l.state = 'OPEN' GROUP BY 1, 2, 3 ORDER BY 1, n DESC`) {
      row('OPEN', g.account_code, g.kind, `${g.n} lines`, `RM ${rm(g.sen)}`, short(g.note, 90) || '—');
    }

    head(`4. open money-in lines on ${ACCOUNT} with no same-amount entry within 7 days`);
    const lines = await tx`
      SELECT l.id, l.booked_on::text AS d, l.amount_sen, l.description, l.reference, l.kind
        FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
       WHERE l.company_id = ${CO} AND s.account_code = ${ACCOUNT} AND l.state = 'OPEN' AND l.kind = 'OTHER' AND l.amount_sen > 0
       ORDER BY l.booked_on, l.id`;
    const amounts = [...new Set(lines.map((l) => Number(l.amount_sen)))];
    const pays = amounts.length === 0 ? [] : await tx`
      SELECT p.id::text AS id, p.so_doc_no, p.amount_sen, p.paid_at, to_jsonb(p) AS j, o.debtor_name, o.company_id AS co
        FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
       WHERE p.amount_sen IN ${tx(amounts)}`;
    const legs = pays.length === 0 ? [] : await tx`
      SELECT source_doc_no, company_id, je_no, entry_date::text AS d, account_code, debit_sen
        FROM scm.v_gl_entries WHERE source_doc_no IN ${tx(pays.map((p) => p.id))} AND debit_sen > 0`;
    const tally = new Map();
    const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
    for (const l of lines) {
      const on = l.d;
      const text = `${l.description ?? ''} ${l.reference ?? ''}`;
      const near = pays.filter((p) => Number(p.amount_sen) === Number(l.amount_sen) && gap(d10(p.paid_at), on) <= 10);
      const named = near.filter((p) => namesAgree(text, p.debtor_name));
      const showPay = (p) => {
        const leg = legs.filter((g) => g.source_doc_no === p.id).map((g) => `${g.account_code}@${g.d}`).join('+') || 'no money leg';
        const method = p.j.method ?? p.j.payment_method ?? p.j.pay_method ?? '?';
        return `co${p.co ?? '?'} ${p.so_doc_no} ${short(p.debtor_name, 24)} paid ${d10(p.paid_at)} ${method} → ${leg}`;
      };
      let verdict;
      if (named.length > 0) {
        const p = named[0];
        const leg = legs.filter((g) => g.source_doc_no === p.id);
        verdict = Number(p.co) !== CO ? 'keyed in the OTHER company (same customer)'
          : leg.length === 0 ? 'keyed, same customer, but no money leg posted'
            : leg.some((g) => g.account_code === ACCOUNT) ? `keyed, same customer, on ${ACCOUNT} but more than 7 days or already taken`
              : `keyed, same customer, money leg on ${leg.map((g) => g.account_code).join('+')}`;
      } else if (near.length > 0) verdict = 'only a same-amount payment of another customer nearby';
      else verdict = 'no payment of this amount within 10 days, either company';
      bump(verdict);
      row('LINE', on, rm(l.amount_sen), short(l.description, 40), short(l.reference, 40), verdict, (named.length ? named : near).slice(0, 2).map(showPay).join(' ; '));
    }
    for (const [k, n] of tally) row('VERDICT', k, n);
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
