#!/usr/bin/env node
// check-scn-knockoff-events.mjs — READ-ONLY. Owner 2026-10-22: 「这几张cn 不是
// knock off 着ap invoice，这些ap invoice 不是连接着哪一场活动的了？」 — every
// supplier credit note, the AP invoices it knocks off (allocations) or names,
// those invoices' lines with their events, the note's own lines and accounts.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const notes = await sql`
    SELECT n.id, n.note_number, n.status, n.party_name, n.total_sen, n.ap_invoice_id, n.je_no, n.company_id
      FROM scm.acc_credit_notes n WHERE n.kind = 'SCN' AND n.status <> 'CANCELLED' ORDER BY n.note_number`;
  let withEvent = 0;
  for (const n of notes) {
    const allocs = await sql`SELECT ap_invoice_id, amount_sen FROM scm.acc_credit_note_allocations WHERE note_id = ${n.id} AND ap_invoice_id IS NOT NULL`;
    const invIds = [...new Set([n.ap_invoice_id, ...allocs.map((a) => a.ap_invoice_id)].filter(Boolean))];
    const invLines = invIds.length ? await sql`
      SELECT i.invoice_number, l.debit_account_code, l.amount_sen, l.project_id, p.name AS event
        FROM scm.ap_invoice_lines l JOIN scm.ap_invoices i ON i.id = l.invoice_id
        LEFT JOIN projects p ON p.id = l.project_id
       WHERE l.invoice_id = ANY(${invIds}::uuid[]) ORDER BY i.invoice_number, l.line_no` : [];
    const own = await sql`SELECT l.account_code, a.account_name, a.account_type, a.pms_row, l.amount_sen FROM scm.acc_credit_note_lines l LEFT JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.account_code WHERE l.note_id = ${n.id} ORDER BY l.line_no`;
    const events = [...new Set(invLines.map((l) => l.project_id).filter((v) => v != null))];
    if (events.length) withEvent++;
    if (!invIds.length) continue;
    console.log(`ROW|${n.note_number} ${n.status} ${n.party_name} ${(Number(n.total_sen) / 100).toFixed(2)} header-inv=${n.ap_invoice_id ? 'yes' : 'no'} knocks=${allocs.length}`);
    for (const l of own) console.log(`ROW|  cn-line ${l.account_code} ${l.account_name} ${l.account_type} row=${l.pms_row ?? '-'} ${(Number(l.amount_sen) / 100).toFixed(2)}`);
    for (const l of invLines) console.log(`ROW|  inv ${l.invoice_number} ${l.debit_account_code} ${(Number(l.amount_sen) / 100).toFixed(2)} event=${l.project_id ?? '-'} ${l.event ?? ''}`);
  }
  console.log(`ROW|SCN not cancelled: ${notes.length}; knocking off / naming an AP invoice with an event: ${withEvent}`);
} finally { await sql.end(); }
