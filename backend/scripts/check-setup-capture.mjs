#!/usr/bin/env node
// check-setup-capture.mjs — READ-ONLY. Owner 2026-10-21 (先确定): 「这个 setup cost
// 几时会 capture」 — every event shows Setup RM 0.00. The Setup row is filled by
// (a) voucher / AP-invoice lines on an account whose pms_row is 'setup' that
// carry the event (a voucher counts once Checked), or (b) a typed line on the
// event page. What exists since 1 September, and why none reaches an event?
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1), FROM (default 2026-09-01).
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const FROM = String(process.env.FROM || '2026-09-01');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
const KEYWORDS = /set ?up|booth|construct|carpet|install|dismantl|partition|fabricat|signage|lighting|renovat|build/i;

try {
  const accts = await sql`SELECT account_code, account_name, pms_row, needs_event FROM scm.accounts WHERE company_id = ${CO} AND pms_row IS NOT NULL ORDER BY pms_row, account_code`;
  console.log('Accounts that fill an event row:');
  for (const a of accts) console.log(`  ${a.pms_row.padEnd(26)} ${a.account_code} ${a.account_name ?? ''}${a.needs_event ? '' : '  (Event NOT required)'}`);
  const setupCodes = accts.filter((a) => a.pms_row === 'setup').map((a) => a.account_code);

  const pv = await sql`
    SELECT 'PV' AS doc, pv.pv_number AS no, pv.voucher_date::text AS d, pv.status::text AS status, (pv.checked_at IS NOT NULL) AS checked,
           pv.payee_name AS party, l.line_no, l.debit_account_code AS acct, l.amount_sen, l.description, l.project_id
      FROM scm.payment_voucher_lines l JOIN scm.payment_vouchers pv ON pv.id = l.pv_id
     WHERE pv.company_id = ${CO} AND pv.voucher_date >= ${FROM} AND pv.status::text <> 'CANCELLED'`;
  const ap = await sql`
    SELECT 'API' AS doc, i.invoice_number AS no, i.invoice_date::text AS d, i.status AS status, true AS checked,
           s.name AS party, l.line_no, l.debit_account_code AS acct, l.amount_sen, l.description, l.project_id
      FROM scm.ap_invoice_lines l JOIN scm.ap_invoices i ON i.id = l.invoice_id LEFT JOIN scm.suppliers s ON s.id = i.supplier_id
     WHERE i.company_id = ${CO} AND i.invoice_date >= ${FROM} AND i.status <> 'CANCELLED'`;
  const lines = [...pv, ...ap];

  const onSetup = lines.filter((l) => setupCodes.includes(l.acct));
  console.log(`\nLines since ${FROM} on a Setup account (${setupCodes.join(', ')}): ${onSetup.length}, with an event ${onSetup.filter((l) => l.project_id != null).length}`);
  for (const l of onSetup) console.log(`  ${l.doc} ${l.no} ${l.d} ${l.status}${l.checked ? '' : ' (not checked)'} ${l.party} | ${l.acct} RM ${rm(l.amount_sen)} | event ${l.project_id ?? '—'} | "${(l.description ?? '').slice(0, 70)}"`);

  const looksSetup = lines.filter((l) => !setupCodes.includes(l.acct) && KEYWORDS.test(`${l.description ?? ''} ${l.party ?? ''}`));
  console.log(`\nLines whose words look like setup but sit on another account: ${looksSetup.length}`);
  for (const l of looksSetup.slice(0, 40)) {
    const a = accts.find((x) => x.account_code === l.acct);
    console.log(`  ${l.doc} ${l.no} ${l.d} ${l.status} ${l.party} | ${l.acct} (${a?.pms_row ?? 'no row'}) RM ${rm(l.amount_sen)} | event ${l.project_id ?? '—'} | "${(l.description ?? '').slice(0, 70)}"`);
  }

  const typed = await sql`
    SELECT l.project_id, p.name, l.amount, l.description, l.archived_at
      FROM public.project_finance_lines l JOIN public.projects p ON p.id = l.project_id
     WHERE p.company_id = ${CO} AND l.kind = 'cost' AND l.category = 'setup' AND l.archived_at IS NULL AND p.start_date >= ${FROM}`.catch((e) => { console.log(`(typed lines unreadable: ${e.message})`); return []; });
  console.log(`\nTyped Setup lines on events since ${FROM}: ${typed.length}`);
  for (const t of typed.slice(0, 20)) console.log(`  #${t.project_id} ${t.name} RM ${t.amount} "${t.description ?? ''}"`);
} finally {
  await sql.end();
}
