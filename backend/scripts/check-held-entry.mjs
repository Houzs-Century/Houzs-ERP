#!/usr/bin/env node
// check-held-entry.mjs — READ ONLY. Owner 2026-11-10 (2990 HLB Oct, line 28/10 RM 1,682
// "REFUND TO 2990 HC-HPV-2610-113"): Match refused "2990-JE-2610-0263 is already reconciled
// against another movement on 310-0020's statements". Which line holds that entry, who/when,
// the order's payments and the lines of the same amount around it.
// Env: DATABASE_URL, COMPANY_ID (default 2), JE (default 2990-JE-2610-0263), SO (default 2990-SO-2609-042), AMOUNTS (sen, comma).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 2);
const JE = String(process.env.JE || '2990-JE-2610-0263');
const SO = String(process.env.SO || '2990-SO-2609-042');
const AMOUNTS = String(process.env.AMOUNTS || '168200,-168200').split(',').map(Number);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } });
const row = (...p) => console.log(`ROW|${p.join('|')}`);

try {
  await sql.begin('read only', async (tx) => {
    row('-- match rows naming', JE);
    for (const m of await tx`SELECT to_jsonb(m) AS j, l.booked_on::text AS d, l.statement_id, l.line_no, to_jsonb(l)->>'state' AS state, l.amount_sen, l.description, l.reference
        FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id WHERE m.company_id = ${CO} AND m.je_no = ${JE}`) {
      row('MATCH', `line ${m.j.bank_line_id}`, `st${m.statement_id} #${m.line_no}`, m.d, m.state, m.amount_sen, `${m.description} / ${m.reference ?? ''}`, `reason ${m.j.match_reason ?? '-'}`, `at ${m.j.created_at ?? '-'}`, `by ${m.j.matched_by ?? m.j.created_by ?? '-'}`);
    }
    row('-- lines whose posted_je_no names', JE);
    for (const l of await tx`SELECT l.id, l.statement_id, l.line_no, l.booked_on::text AS d, to_jsonb(l)->>'state' AS state, l.amount_sen, l.description, l.reference, to_jsonb(l) AS j
        FROM scm.acc_bank_statement_lines l WHERE l.company_id = ${CO} AND l.posted_je_no LIKE ${'%' + JE + '%'}`) {
      row('POSTED_JE', `line ${l.id}`, `st${l.statement_id} #${l.line_no}`, l.d, l.state, l.amount_sen, `${l.description} / ${l.reference ?? ''}`, `updated ${l.j.updated_at ?? '-'}`, `posted_by ${l.j.posted_by ?? l.j.matched_by ?? '-'}`);
    }
    row('-- the entry itself');
    for (const g of await tx`SELECT je_no, entry_date::text AS d, account_code, debit_sen, credit_sen, source_type, source_doc_no, notes FROM scm.v_gl_entries WHERE company_id = ${CO} AND je_no = ${JE} ORDER BY line_id`) {
      row('GL', g.je_no, g.d, g.account_code, g.debit_sen, g.credit_sen, g.source_type, g.source_doc_no, g.notes ?? '');
    }
    row('-- payments of', SO, 'and the bank lines holding their entries');
    for (const p of await tx`SELECT p.id::text AS id, p.amount_sen, p.paid_at, to_jsonb(p) AS j FROM scm.mfg_sales_order_payments p WHERE p.so_doc_no = ${SO} ORDER BY p.paid_at`) {
      const jes = await tx`SELECT DISTINCT je_no, entry_date::text AS d, account_code FROM scm.v_gl_entries WHERE company_id = ${CO} AND source_doc_no = ${p.id} AND account_code LIKE '31%'`;
      const holders = jes.length === 0 ? [] : await tx`SELECT m.je_no, l.booked_on::text AS d, l.statement_id, l.line_no, l.amount_sen, l.description, l.reference FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id WHERE m.company_id = ${CO} AND m.je_no IN ${tx(jes.map((x) => x.je_no))}`;
      row('PAY', p.id.slice(0, 8), p.amount_sen, String(p.paid_at).slice(0, 25), `method ${p.j.method ?? '?'}`, `note ${String(p.j.notes ?? p.j.note ?? p.j.remark ?? '').slice(0, 60)}`,
        jes.map((x) => `${x.je_no} ${x.d} ${x.account_code}`).join(', ') || 'no bank entry',
        holders.map((h) => `held by st${h.statement_id} #${h.line_no} ${h.d} ${h.amount_sen} ${h.description} / ${h.reference ?? ''}`).join(' ; ') || 'held by no line');
    }
    row('-- bank lines of these amounts, company', CO);
    for (const l of await tx`SELECT l.id, s.account_code, l.statement_id, l.line_no, l.booked_on::text AS d, to_jsonb(l)->>'state' AS state, l.amount_sen, l.description, l.reference, l.posted_je_no,
          (SELECT string_agg(m.je_no || ':' || coalesce(m.match_reason, ''), ',') FROM scm.acc_bank_statement_matches m WHERE m.bank_line_id = l.id) AS held
        FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
       WHERE l.company_id = ${CO} AND l.amount_sen IN ${tx(AMOUNTS)} AND l.booked_on >= '2026-09-15' ORDER BY l.booked_on, l.id`) {
      row('LINE', `line ${l.id}`, l.account_code, `st${l.statement_id} #${l.line_no}`, l.d, l.state, l.amount_sen, `${l.description} / ${l.reference ?? ''}`, l.posted_je_no ?? '-', l.held ?? '-');
    }
    row('-- orders of TAN ENG SIANG or TEA CHEN WAI (either company)');
    for (const o of await tx`SELECT o.company_id, o.doc_no, o.debtor_name FROM scm.mfg_sales_orders o WHERE o.debtor_name ILIKE '%ENG SIANG%' OR o.debtor_name ILIKE '%TEA CHEN%' OR o.debtor_name ILIKE '%CHEN WAI%' ORDER BY o.doc_no`) {
      const pays = await tx`SELECT p.amount_sen, p.paid_at::date::text AS d, to_jsonb(p)->>'method' AS m FROM scm.mfg_sales_order_payments p WHERE p.so_doc_no = ${o.doc_no} ORDER BY p.paid_at`;
      row('ORDER', `co${o.company_id}`, o.doc_no, o.debtor_name, pays.map((p) => `${p.amount_sen}@${p.d} ${p.m}`).join(', ') || 'no payments');
    }
    row('-- Houzs side: HC-HPV-2610-113');
    for (const v of await tx`SELECT to_jsonb(v) AS j FROM scm.payment_vouchers v WHERE v.pv_number = 'HC-HPV-2610-113'`) {
      const j = v.j;
      row('PV', j.pv_number, j.status, j.voucher_date, j.total_sen, j.credit_account_code, String(j.notes ?? j.description ?? '').slice(0, 120), `payee ${j.payee_name ?? j.pay_to_name ?? '-'}`);
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
