#!/usr/bin/env node
// check-conts-3240.mjs — READ-ONLY. Owner 2026-11-09 「什么3240？」: the 05/11
// RM 3,240 credit on 2990's Hong Leong statement ("Fund Transfer / THE CONTS
// SDN. BHD. THE CONTS HPV-2610-347") and what it is matched to; Jenny's QR sale
// 2990-SO-2611-041 and its entry; anything in 2990's books that names The Conts
// or RM 3,240 near the day. One READ ONLY transaction; MODE=apply refused.
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: mode=plan'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const CO = 2;
const j = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
const row = (...p) => console.log(`ROW|${p.join('|')}`);

try {
  await sql.begin('read only', async (tx) => {
    console.log('\n=== Bank lines naming THE CONTS, or RM 3,240 credits, 2990, from 28/10');
    const lines = await tx`
      SELECT l.id, l.statement_id, l.line_no, l.booked_on, l.description, l.reference, l.amount_sen, l.kind, l.state, l.posted_je_no, l.note, l.updated_at
        FROM scm.acc_bank_statement_lines l
       WHERE l.company_id = ${CO} AND l.booked_on >= '2026-10-28'
         AND (l.reference ILIKE '%CONTS%' OR l.description ILIKE '%CONTS%' OR l.amount_sen = 324000)
       ORDER BY l.booked_on, l.id`;
    for (const l of lines) row('LINE', j(l));
    const ids = lines.map((l) => Number(l.id));
    if (ids.length) {
      for (const m of await tx`SELECT * FROM scm.acc_bank_statement_matches WHERE company_id = ${CO} AND bank_line_id IN ${tx(ids)} ORDER BY id`) row('MATCH', j(m));
    }

    console.log('\n=== Jenny 2990-SO-2611-041: payments and their entries');
    for (const p of await tx`SELECT id::text AS id, paid_at, created_at, method, online_type, approval_code, amount_sen, created_by, collected_by FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no = '2990-SO-2611-041'`) {
      row('PAY', j(p));
      for (const e of await tx`SELECT je_no, entry_date, posted, reversed, created_at FROM scm.journal_entries WHERE company_id = ${CO} AND source_type = 'SOPAY' AND source_doc_no = ${p.id} ORDER BY created_at`) row('  JE', j(e));
    }
    for (const o of await tx`SELECT doc_no, debtor_name, phone, status, created_at, ref, customer_so_no FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = '2990-SO-2611-041'`) row('SO', j(o));

    console.log('\n=== Anything in 2990 naming The Conts');
    for (const o of await tx`SELECT doc_no, debtor_name, status, created_at FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND (debtor_name ILIKE '%CONTS%' OR coalesce(ref,'') ILIKE '%CONTS%') ORDER BY created_at DESC LIMIT 10`) row('SO-CONTS', j(o));
    for (const e of await tx`
      SELECT je.je_no, je.entry_date, je.source_type, je.source_doc_no, l.account_code, l.debit_sen, l.credit_sen, l.party_name, l.notes
        FROM scm.journal_entries je JOIN scm.journal_entry_lines l ON l.journal_entry_id = je.id
       WHERE je.company_id = ${CO} AND je.entry_date >= '2026-10-01' AND (coalesce(l.party_name,'') ILIKE '%CONTS%' OR coalesce(l.notes,'') ILIKE '%CONTS%')
       ORDER BY je.entry_date DESC LIMIT 15`) row('JE-CONTS', j(e));

    console.log('\n=== Entries of RM 3,240 debiting 310-0020, 25/10 to 12/11, and who holds them');
    for (const e of await tx`
      SELECT je.je_no, je.entry_date, je.source_type, je.source_doc_no, l.party_name, l.notes,
             (SELECT string_agg(m.bank_line_id::text, ',') FROM scm.acc_bank_statement_matches m WHERE m.company_id = ${CO} AND m.je_no = je.je_no) AS bank_lines
        FROM scm.journal_entries je JOIN scm.journal_entry_lines l ON l.journal_entry_id = je.id
       WHERE je.company_id = ${CO} AND je.posted AND NOT coalesce(je.reversed, false)
         AND l.account_code = '310-0020' AND l.debit_sen = 324000 AND je.entry_date BETWEEN '2026-10-25' AND '2026-11-12'
       ORDER BY je.entry_date`) row('E3240', j(e));
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
