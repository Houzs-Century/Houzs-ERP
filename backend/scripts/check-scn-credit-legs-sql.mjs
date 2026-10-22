#!/usr/bin/env node
// check-scn-credit-legs-sql.mjs — READ-ONLY. Runs the exact SCN_CREDIT_LEGS
// read (scm/lib/event-books.ts, owner 2026-10-22) for every event, before it
// ships: which supplier notes come off which event row, and how much.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const SCN_CREDIT_LEGS = `SELECT l.project_id, ('scn:' || k.note_id::text || ':' || l.id::text) AS leg_id, l.debit_account_code AS account_code,
              0 AS debit_sen, ROUND(k.amount_sen::numeric * l.amount_sen / NULLIF(inv.total_sen, 0))::bigint AS credit_sen,
              ('Credit note ' || k.note_number || ' knocks off ' || inv.invoice_number) AS notes,
              k.je_no AS je_no, to_char(k.note_date, 'YYYY-MM-DD') AS entry_date,
              'SCN' AS source_type, k.note_number AS source_doc_no,
              true AS posted, false AS reversed, NULL::text AS reversed_by_je,
              a.account_name, a.account_type, a.pms_row
         FROM (
           SELECT n.id AS note_id, n.note_number, n.je_no, n.note_date, al.ap_invoice_id, al.amount_sen
             FROM scm.acc_credit_notes n
             JOIN scm.acc_credit_note_allocations al ON al.note_id = n.id AND al.ap_invoice_id IS NOT NULL
            WHERE n.kind = 'SCN' AND n.status = 'POSTED'
           UNION ALL
           SELECT n.id, n.note_number, n.je_no, n.note_date, n.ap_invoice_id, n.total_sen
             FROM scm.acc_credit_notes n
            WHERE n.kind = 'SCN' AND n.status = 'POSTED' AND n.ap_invoice_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM scm.acc_credit_note_allocations x WHERE x.note_id = n.id AND x.ap_invoice_id IS NOT NULL)
         ) k
         JOIN scm.ap_invoices inv ON inv.id = k.ap_invoice_id AND inv.status <> 'CANCELLED'
         JOIN scm.ap_invoice_lines l ON l.invoice_id = inv.id
         LEFT JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.debit_account_code`;
try {
  const rows = await sql.unsafe(`${SCN_CREDIT_LEGS}
        WHERE l.project_id IS NOT NULL AND l.company_id = $1
        ORDER BY k.note_date, k.note_number, l.line_no`, [1]);
  for (const r of rows) console.log(`ROW|#${r.project_id} ${r.source_doc_no} ${r.account_code} ${r.account_name} row=${r.pms_row ?? '-'} Cr ${(Number(r.credit_sen) / 100).toFixed(2)} | ${r.notes} | je=${r.je_no} ${r.entry_date}`);
  console.log(`ROW|rows: ${rows.length}`);
  const one = await sql.unsafe(`${SCN_CREDIT_LEGS}
        WHERE l.project_id = $1 AND l.company_id = $2
        ORDER BY k.note_date, k.note_number, l.line_no`, [2267, 1]);
  console.log(`ROW|single read #2267: ${one.length} row(s), Cr ${(one.reduce((s, r) => s + Number(r.credit_sen), 0) / 100).toFixed(2)}`);
} finally { await sql.end(); }
