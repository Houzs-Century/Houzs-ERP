#!/usr/bin/env node
// check-odb-lines-without-event.mjs — READ-ONLY. Which Other Debtor bills billed
// an event cost back (a line credited to an account that feeds a PMS event row,
// e.g. 900-R032 RENTAL - EXHIBITION) WITHOUT naming the event, so the money
// recovered does not lower that event's row (owner 2026-10-19, ledger item 4).
//
// The Event field on the bill line exists since #4398 (2026-10-01); Finance picks
// it on the bill and the edit re-posts. This lists the bills to open: live (not
// cancelled) bills from FROM onward, their untagged lines on a pms_row account,
// and how many of their lines already name an event.
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-01).
//   npx tsx scripts/check-odb-lines-without-event.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });

try {
  const rows = await sql`
    SELECT b.bill_number, b.bill_date::text AS bill_date, b.status, d.name AS debtor,
           l.line_no, l.description, l.credit_account_code, a.account_name, a.pms_row, l.amount_sen, l.project_id
      FROM scm.acc_debtor_bills b
      JOIN scm.acc_debtors d ON d.id = b.debtor_id
      JOIN scm.acc_debtor_bill_lines l ON l.bill_id = b.id
      LEFT JOIN scm.accounts a ON a.company_id = b.company_id AND a.account_code = l.credit_account_code
     WHERE b.company_id = ${CO} AND b.bill_date >= ${FROM} AND b.status <> 'CANCELLED'
     ORDER BY b.bill_date, b.bill_number, l.line_no`;
  const onRow = rows.filter((r) => r.pms_row);
  const untagged = onRow.filter((r) => r.project_id == null);
  console.log(`Company ${CO}, live Other Debtor bills from ${FROM}: ${new Set(rows.map((r) => r.bill_number)).size}`);
  console.log(`Lines on an event-row account: ${onRow.length} (with an event ${onRow.length - untagged.length}, without ${untagged.length})`);
  let total = 0;
  for (const r of untagged) {
    total += Number(r.amount_sen);
    console.log(`- ${r.bill_number} ${r.bill_date} ${r.status} "${r.debtor}" line ${r.line_no}: RM ${rm(r.amount_sen)} → ${r.credit_account_code} ${r.account_name ?? ''} (row ${r.pms_row}) — "${(r.description ?? '').slice(0, 90)}"`);
  }
  console.log(`Untagged total: RM ${rm(total)}`);
  const tagged = onRow.filter((r) => r.project_id != null);
  for (const r of tagged) console.log(`  (already tagged) ${r.bill_number} line ${r.line_no} → event #${r.project_id} RM ${rm(r.amount_sen)}`);
} finally {
  await sql.end();
}
