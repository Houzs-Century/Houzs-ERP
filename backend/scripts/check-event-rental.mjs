#!/usr/bin/env node
// check-event-rental.mjs — READ-ONLY. Why an event's Rental reads negative
// (owner 2026-10-22: Books not complete says "missing" while Project Overview
// shows an amount): the event's typed rental lines and every journal leg
// tagged to it whose account is a Rental row, with the document behind it.
import postgres from 'postgres';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const events = await sql`
    SELECT p.id, p.name, p.start_date::text AS s, p.end_date::text AS e, p.company_id
      FROM projects p
     WHERE p.archived_at IS NULL
       AND (p.id = 343 OR p.name ILIKE '%MALL MGT%IOI%' OR p.name ILIKE '%[ZANOTTI] MALL MGMT%SUNWAY CARNIVAL%' OR p.name ILIKE '%[ERGOTEX] SOLO%SUNWAY KLUANG%')
     ORDER BY p.id`;
  for (const ev of events) {
    console.log(`\n=== #${ev.id} ${ev.name} ${ev.s}..${ev.e} co${ev.company_id}`);
    const typed = await sql`
      SELECT kind, category, amount::text AS amount, auto_source, note, created_at::date::text AS d
        FROM project_finance_lines
       WHERE project_id = ${ev.id} AND archived_at IS NULL AND (category = 'rental' OR kind = 'cost')
       ORDER BY category, id`;
    for (const t of typed) console.log(`typed ${t.kind}/${t.category} ${t.amount}${t.auto_source ? ` auto=${t.auto_source}` : ''} ${t.d} ${String(t.note ?? '').slice(0, 60)}`);
    const legs = await sql`
      SELECT je.je_no, je.entry_date::text AS d, je.source_type, je.source_doc_no, je.posted, je.reversed,
             l.account_code, a.account_name, a.pms_row, l.debit_sen, l.credit_sen, left(coalesce(l.notes, ''), 70) AS notes
        FROM scm.journal_entry_lines l
        JOIN scm.journal_entries je ON je.id = l.journal_entry_id
        LEFT JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.account_code
       WHERE l.project_id = ${ev.id}
       ORDER BY je.entry_date, je.je_no, l.line_no`;
    let rentalNet = 0;
    for (const g of legs) {
      const net = (Number(g.debit_sen ?? 0) - Number(g.credit_sen ?? 0)) / 100;
      const counts = g.posted && !g.reversed;
      if (g.pms_row === 'rental' && counts) rentalNet += net;
      console.log(`leg ${g.d} ${g.je_no} ${g.source_type}/${g.source_doc_no} ${g.account_code} ${g.account_name} row=${g.pms_row ?? '-'} Dr ${(Number(g.debit_sen ?? 0) / 100).toFixed(2)} Cr ${(Number(g.credit_sen ?? 0) / 100).toFixed(2)} posted=${g.posted} reversed=${g.reversed} | ${g.notes}`);
    }
    console.log(`rental net from books (posted, not reversed): ${rentalNet.toFixed(2)}`);
  }
} finally { await sql.end(); }
