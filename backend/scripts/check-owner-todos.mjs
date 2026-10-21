#!/usr/bin/env node
// check-owner-todos.mjs — READ-ONLY. Owner 2026-10-21 「我现在要做什么啊？」: which
// of the things left with him are still open —
//   1. the 14 orders the evening reports put at another fair (moved yet?),
//   2. the AKEMI FRAGRANCE rate card (commission reads 0 without it),
//   3. Other Debtor bill lines on an event row with no event picked.
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
const DOCS = ['HC-SO-2610-012', 'HC-SO-2610-075', 'HC-SO-2610-166', 'HC-SO-2610-167', 'HC-SO-2610-180', 'HC-SO-2610-181', 'HC-SO-2610-208',
  'HC-SO-2610-221', 'HC-SO-2610-222', 'HC-SO-2610-226', 'HC-SO-2610-256', 'HC-SO-2610-257', 'HC-SO-2610-281', 'HC-SO-2610-282'];
const TARGET = { 'HC-SO-2610-012': 2235, 'HC-SO-2610-075': 2270, 'HC-SO-2610-166': 307, 'HC-SO-2610-167': 307, 'HC-SO-2610-180': 307, 'HC-SO-2610-181': 307,
  'HC-SO-2610-208': 2259, 'HC-SO-2610-221': 306, 'HC-SO-2610-222': 306, 'HC-SO-2610-226': 309, 'HC-SO-2610-256': 2260, 'HC-SO-2610-257': 2260,
  'HC-SO-2610-281': 306, 'HC-SO-2610-282': 2260 };

try {
  const sos = await sql`SELECT doc_no, project_id, status::text AS status FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no IN ${sql(DOCS)} ORDER BY doc_no`;
  const moved = sos.filter((s) => Number(s.project_id) === TARGET[s.doc_no]);
  console.log(`1. report-placed orders: ${sos.length} found, already on the reported fair ${moved.length}, still to move ${sos.length - moved.length}`);
  for (const s of sos) console.log(`   ${s.doc_no} ${s.status} now ${s.project_id ?? '—'} → report ${TARGET[s.doc_no]}${Number(s.project_id) === TARGET[s.doc_no] ? ' (done)' : ''}`);

  const cards = await sql`SELECT * FROM public.project_cost_rates WHERE upper(brand) LIKE '%FRAGRANCE%'`;
  const fairs = await sql`SELECT id, name, start_date, end_date FROM public.projects WHERE company_id = ${CO} AND upper(coalesce(brand, '')) LIKE '%FRAGRANCE%' AND archived_at IS NULL ORDER BY start_date DESC LIMIT 5`;
  console.log(`2. AKEMI FRAGRANCE rate card: ${cards.length ? JSON.stringify(cards[0]).slice(0, 300) : 'NONE'} | fairs with that brand: ${fairs.map((f) => `#${f.id} ${f.name} ${f.start_date}`).join('; ') || '—'}`);

  const odb = await sql`
    SELECT b.bill_number, b.bill_date::text AS bill_date, d.name AS debtor, l.line_no, l.amount_sen, l.project_id, a.pms_row
      FROM scm.acc_debtor_bills b
      JOIN scm.acc_debtors d ON d.id = b.debtor_id
      JOIN scm.acc_debtor_bill_lines l ON l.bill_id = b.id
      LEFT JOIN scm.accounts a ON a.company_id = b.company_id AND a.account_code = l.credit_account_code
     WHERE b.company_id = ${CO} AND b.bill_date >= '2026-09-01' AND b.status <> 'CANCELLED' AND a.pms_row IS NOT NULL
     ORDER BY b.bill_date, b.bill_number, l.line_no`;
  const untagged = odb.filter((r) => r.project_id == null);
  console.log(`3. Other Debtor bill lines on an event row since 1 Sep: ${odb.length}, without an event ${untagged.length}`);
  for (const r of untagged) console.log(`   ${r.bill_number} ${r.bill_date} "${r.debtor}" line ${r.line_no} RM ${rm(r.amount_sen)}`);
} finally {
  await sql.end();
}
