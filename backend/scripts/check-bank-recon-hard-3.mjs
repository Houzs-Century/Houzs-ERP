#!/usr/bin/env node
// check-bank-recon-hard-3.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-10 「为何我感觉现在的bank recon 很难对账啊？」 — how much of the hand work the
// "same amount + same name" rule would have done had it read the customer's name the
// screen shows (the order's debtor for a customer payment) instead of the entry's own
// party name, which a customer payment never carries:
//  1. every bank line matched BY HAND, per company: what it was matched to, whether the
//     bank's words name that customer, and whether it was the only same-amount entry
//     within 7 days on that bank account;
//  2. imported (AutoCount) payments by month and company, and how many have a money leg.
// Env: DATABASE_URL, COMPANY_IDS (default "1,2").
import postgres from 'postgres';
import { namesAgree, ENTRY_MATCH_WINDOW_DAYS } from '../src/acc/bank-match.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const head = (t) => console.log(`\n=== ${t}`);
const gap = (a, b) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const short = (s, n = 50) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

try {
  await sql.begin('read only', async (tx) => {
    for (const CO of COS) {
      head(`1. company ${CO}: lines matched by hand`);
      const manual = await tx`
        SELECT l.id, s.account_code, l.booked_on::text AS d, to_char(l.booked_on, 'YYYY-MM') AS m, l.amount_sen, l.description, l.reference,
               m.je_no, m.match_reason
          FROM scm.acc_bank_statement_matches m
          JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id
          JOIN scm.acc_bank_statements s ON s.id = l.statement_id
         WHERE m.company_id = ${CO} AND l.state = 'POSTED'
           AND (SELECT count(*) FROM scm.acc_bank_statement_matches x WHERE x.bank_line_id = l.id) = 1`;
      const jes = [...new Set(manual.map((r) => r.je_no))];
      const legs = jes.length === 0 ? [] : await tx`
        SELECT DISTINCT ON (je_no) je_no, source_type, source_doc_no, party_name, notes
          FROM scm.v_gl_entries WHERE company_id = ${CO} AND je_no IN ${tx(jes)} ORDER BY je_no, line_id`;
      const legOf = new Map(legs.map((g) => [g.je_no, g]));
      const payIds = legs.filter((g) => g.source_type === 'SOPAY' && /^[0-9a-f-]{36}$/i.test(String(g.source_doc_no ?? ''))).map((g) => g.source_doc_no);
      const pays = payIds.length === 0 ? [] : await tx`
        SELECT p.id::text AS id, o.debtor_name FROM scm.mfg_sales_order_payments p
          LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no WHERE p.id::text IN ${tx(payIds)}`;
      const customerOf = new Map(pays.map((p) => [p.id, p.debtor_name]));
      /* Same-amount entries per account, for "was it the only one within 7 days". */
      const accounts = [...new Set(manual.map((r) => r.account_code))];
      const book = accounts.length === 0 ? [] : await tx`
        SELECT je_no, account_code, entry_date::text AS d, sum(debit_sen - credit_sen)::bigint AS net
          FROM scm.v_gl_entries WHERE company_id = ${CO} AND account_code IN ${tx(accounts)}
           AND NOT (coalesce(reversed, false) OR reversed_by_je IS NOT NULL)
         GROUP BY 1, 2, 3`;
      const tally = new Map();
      const add = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
      for (const r of manual) {
        const g = legOf.get(r.je_no);
        const type = g?.source_type ?? '?';
        const reason = r.match_reason ?? '—';
        const key = `${r.account_code} ${r.m}`;
        add(`${key}|by ${reason}|all`);
        if (reason !== 'manual') continue;
        add(`${key}|by hand|${type}`);
        const text = `${r.description ?? ''} ${r.reference ?? ''}`;
        const ownName = g?.party_name ?? g?.notes ?? null;
        const shown = type === 'SOPAY' ? (customerOf.get(String(g?.source_doc_no)) ?? null) : (g?.party_name ?? null);
        const same = book.filter((b) => b.account_code === r.account_code && Number(b.net) === Number(r.amount_sen) && gap(b.d, r.d) <= ENTRY_MATCH_WINDOW_DAYS).length;
        if (namesAgree(text, ownName)) add(`${key}|by hand|the entry's own name already agrees`);
        else if (shown && namesAgree(text, shown)) add(`${key}|by hand|the customer's name agrees${same === 1 ? ', the only same-amount entry → would match itself' : ` (${same} same-amount entries)`}`);
        else add(`${key}|by hand|names differ`);
      }
      for (const [k, n] of [...tally.entries()].sort()) row('MANUAL', `co${CO}`, k, n);
    }

    head('2. imported (AutoCount) payments by company and month');
    for (const r of await tx`
      SELECT o.company_id, to_char(p.paid_at, 'YYYY-MM') AS m, count(*)::int AS n, sum(p.amount_sen)::bigint AS sen,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM scm.v_gl_entries g WHERE g.source_doc_no = p.id::text))::int AS with_journal
        FROM scm.mfg_sales_order_payments p JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
       WHERE to_jsonb(p)->>'method' = 'imported' AND p.paid_at >= '2026-08-01'
       GROUP BY 1, 2 ORDER BY 1, 2`) {
      row('IMPORTED', `co${r.company_id}`, r.m, `${r.n} payments`, `RM ${rm(r.sen)}`, `with a journal ${r.with_journal}`);
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
