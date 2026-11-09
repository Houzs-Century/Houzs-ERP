#!/usr/bin/env node
// check-hlb-qr-bank.mjs — READ-ONLY. The bank side of Hong Leong's DuitNow QR
// lines: the Sales Order payments that look like the late-October / November
// QR money (keyed as Bank transfer), the journal each one posted, whether a
// bank line already claims it, and every credit on the company's bank
// statements from 28/10 on — to see whether those payments have bank credits
// of their own or are the QR merchant's daily credit.
//
// Writes nothing: one READ ONLY transaction, MODE=apply refused.
// Env: DATABASE_URL, COMPANY_ID (default 2 = 2990), FROM (default 2026-10-28).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('check-hlb-qr-bank.mjs is read-only: run it with mode=plan.'); process.exit(1); }

const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const CO = Number(process.env.COMPANY_ID || 2);
const FROM = /^\d{4}-\d{2}-\d{2}$/.test(process.env.FROM || '') ? process.env.FROM : '2026-10-28';
const DOCS = ['2990-SO-2611-019', '2990-SO-2611-041', '2990-SO-2610-010', '2990-SO-2611-042', '2990-SO-2611-020'];
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v == null ? '—' : String(v).slice(0, 16));
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const head = (t) => console.log(`\n=== ${t}`);
const pick = (o, keys) => keys.filter((k) => k in o).map((k) => `${k}=${o[k] instanceof Date ? day(o[k]) : o[k]}`).join(' ');

try {
  await sql.begin('read only', async (tx) => {
    const [where] = await tx`SELECT table_schema FROM information_schema.tables WHERE table_name = 'journal_entries' ORDER BY (table_schema = 'scm') DESC LIMIT 1`;
    const S = where?.table_schema ?? 'scm';
    head(`journal tables live in schema ${S}`);

    head('The payments');
    const pays = await tx`
      SELECT p.id::text AS id, p.so_doc_no, p.paid_at, p.created_at, p.method, p.merchant_provider, p.online_type,
             p.approval_code, p.account_sheet, p.amount_sen, p.note, o.debtor_name
        FROM scm.mfg_sales_order_payments p
        LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no AND o.company_id = p.company_id
       WHERE p.company_id = ${CO} AND p.so_doc_no IN ${tx(DOCS)}
       ORDER BY p.so_doc_no, p.paid_at`;
    for (const p of pays) {
      row('PAY', p.so_doc_no, p.debtor_name ?? '—', `paid ${day(p.paid_at)}`, `keyed ${day(p.created_at)}`, `RM ${rm(p.amount_sen)}`, p.method,
        `prov ${p.merchant_provider ?? '—'}`, `online ${p.online_type ?? '—'}`, `code ${p.approval_code ?? '—'}`, `sheet ${p.account_sheet ?? '—'}`,
        `note ${p.note ?? '—'}`, `id ${p.id}`);
    }

    head('Their journals, lines and bank claims');
    const ids = pays.map((p) => p.id);
    const jes = ids.length === 0 ? [] : await tx`
      SELECT * FROM ${tx(S)}.journal_entries WHERE source_type = 'SOPAY' AND source_doc_no IN ${tx(ids)} ORDER BY je_no`;
    for (const je of jes) {
      const p = pays.find((x) => x.id === String(je.source_doc_no));
      row('JE', p?.so_doc_no ?? je.source_doc_no, pick(je, ['je_no', 'entry_date', 'posted', 'reversed', 'reversed_by_je']));
      const lines = await tx`SELECT account_code, debit_sen, credit_sen FROM ${tx(S)}.journal_entry_lines WHERE journal_entry_id = ${je.id} ORDER BY line_no`;
      for (const l of lines) row('  JL', je.je_no, l.account_code, `Dr ${rm(l.debit_sen)}`, `Cr ${rm(l.credit_sen)}`);
      const claims = await tx`
        SELECT m.bank_line_id, m.amount_sen, m.match_reason, bl.booked_on, bl.amount_sen AS line_amount, bl.state, bl.description, bl.reference
          FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines bl ON bl.id = m.bank_line_id
         WHERE m.company_id = ${CO} AND m.je_no = ${je.je_no}`;
      const posted = await tx`SELECT id, booked_on, amount_sen, state, description, reference FROM scm.acc_bank_statement_lines WHERE company_id = ${CO} AND posted_je_no LIKE ${'%' + je.je_no + '%'}`;
      row('  CLAIM', je.je_no, claims.length === 0 && posted.length === 0 ? 'no bank line claims it'
        : [...claims.map((c) => `match→line ${c.bank_line_id} ${c.booked_on} RM ${rm(c.line_amount)} ${c.state} ${c.description} / ${c.reference ?? ''}`),
          ...posted.map((c) => `posted→line ${c.id} ${c.booked_on} RM ${rm(c.amount_sen)} ${c.state} ${c.description} / ${c.reference ?? ''}`)].join(' ; '));
    }

    head(`Bank statements of company ${CO} (last day each covers)`);
    for (const s of await tx`
      SELECT s.id, s.account_code, min(l.booked_on) AS first_day, max(l.booked_on) AS last_day, count(*) AS n
        FROM scm.acc_bank_statements s JOIN scm.acc_bank_statement_lines l ON l.statement_id = s.id
       WHERE s.company_id = ${CO} GROUP BY s.id, s.account_code ORDER BY s.id DESC LIMIT 8`) {
      row('STMT', s.id, s.account_code, `${s.first_day}..${s.last_day}`, `lines ${s.n}`);
    }

    head(`Every credit on company ${CO}'s statements from ${FROM}`);
    for (const l of await tx`
      SELECT l.id, l.statement_id, s.account_code, l.line_no, l.booked_on, l.amount_sen, l.kind, l.state, l.description, l.reference, l.posted_je_no
        FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
       WHERE l.company_id = ${CO} AND l.booked_on >= ${FROM} AND l.amount_sen > 0 AND l.state <> 'IGNORED'
       ORDER BY s.account_code, l.booked_on, l.line_no`) {
      row('CR', l.id, l.account_code, `st ${l.statement_id}`, `line ${l.line_no}`, l.booked_on, `RM ${rm(l.amount_sen)}`, l.kind, l.state,
        `${l.description} / ${l.reference ?? ''}`, `JE ${l.posted_je_no ?? '—'}`);
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
