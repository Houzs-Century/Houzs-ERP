#!/usr/bin/env node
// check-payments-by-approval.mjs — READ ONLY. Every SO payment carrying one card
// approval code in one company, with its receipt — was one swipe split across
// orders? (owner 2026-10-29, 2990 October receipts check). Env: DATABASE_URL,
// COMPANY_ID, APPROVAL.
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 2);
const CODE = String(process.env.APPROVAL || '').trim();
if (!CODE) { console.error('APPROVAL is required.'); process.exit(2); }
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const rows = await sql`
    SELECT p.so_doc_no, p.id, p.paid_at::text AS paid, p.method, p.amount_sen, p.created_at,
           o.or_number, o.status AS or_status, o.amount_sen AS or_sen
      FROM scm.mfg_sales_order_payments p
      LEFT JOIN scm.acc_official_receipts o ON o.payment_source = 'SOPAY' AND o.payment_id = p.id::text
     WHERE p.company_id = ${CO} AND p.approval_code = ${CODE}
     ORDER BY p.created_at`;
  for (const r of rows) console.log(`ROW|${r.so_doc_no} | paid ${r.paid} | ${r.method} | RM ${rm(r.amount_sen)} | receipt ${r.or_number ?? '-'} ${r.or_status ?? ''} ${r.or_sen == null ? '' : 'RM ' + rm(r.or_sen)}`);
  console.log(`ROW|${rows.length} payment(s) with approval ${CODE}`);
} finally {
  await sql.end();
}
