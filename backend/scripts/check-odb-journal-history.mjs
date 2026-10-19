#!/usr/bin/env node
// check-odb-journal-history.mjs — READ-ONLY. Every journal entry an Other Debtor
// bill has written (ODB, ODB_REVERSAL), in the order they were made, so a bill
// whose entries do not net to ONE live posting shows up.
//
// WHY. check-project-ledger-links.mjs (run 39240150132) found 900-R032 RENTAL -
// EXHIBITION carrying ODB credits of RM 276,450 (6 legs) and ODB_REVERSAL debits
// of RM 92,150 (2 legs) since 2026-09-01 — net RM 184,300 — while the live bills
// crediting 900-R032 total RM 92,150 (check-odb-lines-without-event.mjs). An edit
// re-posts (routes/other-debtors.ts: reverse the live ODB entry, post afresh), so
// a healthy bill has exactly one ODB entry not reversed.
//
// Per bill (company COMPANY_ID, bills dated FROM onward, cancelled included):
// the bill row, then each entry — je_no, date, type, posted, reversed, reversed
// by, created, total, narration — and the net of its live entries per account.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-01).
//   npx tsx scripts/check-odb-journal-history.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });

try {
  const bills = await sql`
    SELECT b.bill_number, b.bill_date::text AS bill_date, b.status, b.total_sen, b.received_sen,
           to_char(b.created_at, 'YYYY-MM-DD HH24:MI') AS created, b.created_by, d.name AS debtor
      FROM scm.acc_debtor_bills b JOIN scm.acc_debtors d ON d.id = b.debtor_id
     WHERE b.company_id = ${CO} AND b.bill_date >= ${FROM}
     ORDER BY b.bill_number`;
  const entries = await sql`
    SELECT je.id::text AS id, je.je_no, je.entry_date::text AS entry_date, je.source_type, je.source_doc_no,
           je.posted, je.reversed, je.reversed_by_je::text AS reversed_by_je,
           to_char(je.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created, je.total_debit_sen, je.narration
      FROM scm.journal_entries je
     WHERE je.company_id = ${CO} AND je.source_type IN ('ODB', 'ODB_REVERSAL')
       AND je.source_doc_no IN ${sql(bills.map((b) => b.bill_number).concat(['-']))}
     ORDER BY je.source_doc_no, je.created_at, je.je_no`;
  const legs = await sql`
    SELECT l.journal_entry_id::text AS je_id, l.account_code, l.debit_sen, l.credit_sen, l.project_id
      FROM scm.journal_entry_lines l
     WHERE l.journal_entry_id IN ${sql(entries.map((e) => e.id).concat(['00000000-0000-0000-0000-000000000000']))}`;
  const jeNoOf = new Map(entries.map((e) => [e.id, e.je_no]));
  const legsOf = new Map();
  for (const l of legs) { const a = legsOf.get(l.je_id) ?? []; a.push(l); legsOf.set(l.je_id, a); }

  console.log(`Company ${CO}: Other Debtor bills dated ${FROM} onward: ${bills.length}; their ODB entries: ${entries.length}`);
  for (const b of bills) {
    const mine = entries.filter((e) => e.source_doc_no === b.bill_number);
    const liveOdb = mine.filter((e) => e.source_type === 'ODB' && !e.reversed);
    const flag = b.status === 'CANCELLED' ? (liveOdb.length === 0 ? 'ok' : 'CHECK') : (liveOdb.length === 1 ? 'ok' : 'CHECK');
    console.log(`\n${b.bill_number} ${b.bill_date} ${b.status} "${b.debtor}" total RM ${rm(b.total_sen)} received RM ${rm(b.received_sen)} created ${b.created} by ${b.created_by ?? '—'} → ${mine.length} entries, live ODB ${liveOdb.length} [${flag}]`);
    const net = new Map();
    for (const e of mine) {
      console.log(`  ${e.je_no} ${e.entry_date} ${e.source_type} posted=${e.posted} reversed=${e.reversed}${e.reversed_by_je ? ` by ${jeNoOf.get(e.reversed_by_je) ?? e.reversed_by_je}` : ''} created ${e.created} RM ${rm(e.total_debit_sen)} — ${(e.narration ?? '').slice(0, 80)}`);
      if (!e.posted) continue;
      for (const l of legsOf.get(e.id) ?? []) net.set(l.account_code, (net.get(l.account_code) ?? 0) + Number(l.debit_sen) - Number(l.credit_sen));
    }
    console.log(`  net of posted entries: ${[...net].filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v > 0 ? 'Dr' : 'Cr'} RM ${rm(Math.abs(v))}`).join('; ') || 'nil'}`);
  }
} finally {
  await sql.end();
}
