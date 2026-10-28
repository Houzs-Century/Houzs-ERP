#!/usr/bin/env node
// check-houzs-scn-origin.mjs — READ ONLY. Where Houzs's supplier credit notes
// come from (owner 2026-10-28 on the new Supplier & Other Creditor CN / DN
// page: 为什么又这么多cn 呢？): by note month, who raised them and when, what
// they carry (reference, invoice credited, knock-offs), and whether their
// journals fall inside the books (from the company's books start).
// Env: DATABASE_URL, COMPANY_ID (1).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const out = (s) => console.log(`ROW|${s}`);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { dateText: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } });
try {
  const [bs] = await sql`SELECT books_start_date FROM scm.acc_company_settings WHERE company_id = ${CO}`;
  out(`books start: ${bs?.books_start_date ?? 'none'}`);
  const byMonth = await sql`SELECT to_char(note_date, 'YYYY-MM') AS m, status, count(*)::int AS n, sum(total_sen)::bigint AS sen,
      bool_or(opening) AS any_opening
    FROM scm.acc_credit_notes WHERE company_id = ${CO} AND kind = 'SCN' GROUP BY 1, 2 ORDER BY 1, 2`;
  for (const r of byMonth) out(`month ${r.m} ${r.status}: ${r.n} RM ${(Number(r.sen) / 100).toFixed(2)}${r.any_opening ? ' (opening)' : ''}`);
  const byWho = await sql`SELECT coalesce(created_by, '-') AS who, to_char(min(created_at) AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS first,
      to_char(max(created_at) AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS last, count(*)::int AS n,
      min(note_date) AS d1, max(note_date) AS d2
    FROM scm.acc_credit_notes WHERE company_id = ${CO} AND kind = 'SCN' GROUP BY 1 ORDER BY 4 DESC`;
  for (const r of byWho) out(`raised by ${r.who}: ${r.n} notes, created ${r.first} → ${r.last}, dated ${r.d1} → ${r.d2}`);
  const carry = await sql`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE source_doc_no IS NOT NULL)::int AS with_ref,
      count(*) FILTER (WHERE purchase_invoice_id IS NOT NULL OR ap_invoice_id IS NOT NULL)::int AS names_invoice,
      count(*) FILTER (WHERE notes IS NOT NULL)::int AS with_notes,
      count(*) FILTER (WHERE reason IS NOT NULL)::int AS with_reason
    FROM scm.acc_credit_notes WHERE company_id = ${CO} AND kind = 'SCN'`;
  out(`carry: ${JSON.stringify(carry[0])}`);
  const samples = await sql`SELECT note_number, note_date, party_name, total_sen, status, source_doc_no, left(coalesce(reason, ''), 80) AS reason, left(coalesce(notes, ''), 120) AS notes, created_by
    FROM scm.acc_credit_notes WHERE company_id = ${CO} AND kind = 'SCN' ORDER BY note_date LIMIT 6`;
  for (const r of samples) out(`oldest: ${r.note_number} ${r.note_date} ${r.party_name} ${(Number(r.total_sen) / 100).toFixed(2)} ${r.status} ref=${r.source_doc_no ?? '-'} reason=${r.reason} notes=${r.notes} by=${r.created_by}`);
  const recent = await sql`SELECT note_number, note_date, party_name, total_sen, status, source_doc_no, left(coalesce(reason, ''), 80) AS reason, left(coalesce(notes, ''), 120) AS notes, created_by
    FROM scm.acc_credit_notes WHERE company_id = ${CO} AND kind = 'SCN' ORDER BY note_date DESC LIMIT 6`;
  for (const r of recent) out(`newest: ${r.note_number} ${r.note_date} ${r.party_name} ${(Number(r.total_sen) / 100).toFixed(2)} ${r.status} ref=${r.source_doc_no ?? '-'} reason=${r.reason} notes=${r.notes} by=${r.created_by}`);
  const lines = await sql`SELECT l.account_code, count(*)::int AS n, sum(l.amount_sen)::bigint AS sen
    FROM scm.acc_credit_note_lines l JOIN scm.acc_credit_notes n ON n.id = l.note_id
    WHERE n.company_id = ${CO} AND n.kind = 'SCN' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`;
  for (const r of lines) out(`line account ${r.account_code}: ${r.n} lines RM ${(Number(r.sen) / 100).toFixed(2)}`);
  const inBooks = await sql`SELECT
      count(*) FILTER (WHERE n.status = 'POSTED' AND bs.books_start_date IS NOT NULL AND n.note_date < bs.books_start_date)::int AS posted_before_start,
      count(*) FILTER (WHERE n.status = 'POSTED' AND (bs.books_start_date IS NULL OR n.note_date >= bs.books_start_date))::int AS posted_in_books
    FROM scm.acc_credit_notes n LEFT JOIN scm.acc_company_settings bs ON bs.company_id = n.company_id
    WHERE n.company_id = ${CO} AND n.kind = 'SCN'`;
  out(`posted before the books start: ${inBooks[0].posted_before_start}; posted inside the books: ${inBooks[0].posted_in_books}`);
  const glSeen = await sql`SELECT count(DISTINCT source_doc_no)::int AS n FROM scm.v_gl_entries WHERE company_id = ${CO} AND source_type = 'SCN'`;
  out(`SCN journals the books (v_gl_entries) count: ${glSeen[0].n}`);
  const allocs = await sql`SELECT count(*)::int AS n, count(DISTINCT a.note_id)::int AS notes, sum(a.applied_sen)::bigint AS sen
    FROM scm.acc_credit_note_allocations a JOIN scm.acc_credit_notes n ON n.id = a.note_id WHERE n.company_id = ${CO} AND n.kind = 'SCN'`;
  out(`knock-offs: ${allocs[0].n} rows on ${allocs[0].notes} notes, applied RM ${(Number(allocs[0].sen ?? 0) / 100).toFixed(2)}`);
  const drafts = await sql`SELECT note_number, note_date, party_name, total_sen, source_doc_no, created_by, to_char(created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS made
    FROM scm.acc_credit_notes WHERE company_id = ${CO} AND kind = 'SCN' AND status = 'DRAFT' ORDER BY note_date LIMIT 25`;
  for (const r of drafts) out(`draft: ${r.note_number} ${r.note_date} ${r.party_name} ${(Number(r.total_sen) / 100).toFixed(2)} ref=${r.source_doc_no ?? '-'} by=${r.created_by} made=${r.made}`);
} finally {
  await sql.end();
}
