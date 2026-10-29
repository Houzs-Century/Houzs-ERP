#!/usr/bin/env node
// check-receipt-payment-trail.mjs — READ ONLY. For named Official Receipts: the
// receipt, the payment it was issued for (if it still exists), every payment of
// the same order, and the order's payment history in the SO audit log — what
// happened to the payment after its receipt went out (owner 2026-10-29, Official
// Receipts October check: 这个是什么意思？).
// Env: DATABASE_URL, ORS (comma-separated OR numbers).
import postgres from 'postgres';

const ORS = String(process.env.ORS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (ORS.length === 0) { console.error('ORS is required.'); process.exit(2); }
const rm = (sen) => (Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v == null ? '-' : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 19).replace('T', ' '));
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  for (const orNo of ORS) {
    const [r] = await sql`SELECT * FROM scm.acc_official_receipts WHERE or_number = ${orNo}`;
    if (!r) { console.log(`\nOR|${orNo} NOT FOUND`); continue; }
    console.log(`\nOR|${r.or_number} co ${r.company_id} ${r.status} | ${r.payment_source} ${r.payment_id} | doc ${r.doc_no} | paid ${day(r.paid_at)} | RM ${rm(r.amount_sen)}`
      + ` | channel ${r.channel_account_code ?? '-'} | made ${day(r.created_at)}${r.formal_at ? ` | formal ${day(r.formal_at)}` : ''}`);
    const pays = r.payment_source === 'SIPAY'
      ? await sql`SELECT p.*, NULL::text AS so_doc_no FROM scm.sales_invoice_payments p WHERE p.id::text = ${String(r.payment_id)}`
      : await sql`SELECT p.* FROM scm.mfg_sales_order_payments p WHERE p.id::text = ${String(r.payment_id)}`;
    if (pays.length === 0) console.log('PAY|its payment: GONE (no row with that id)');
    for (const p of pays) console.log(`PAY|its payment: paid ${day(p.paid_at)} | ${p.method} | RM ${rm(p.amount_sen)} | made ${day(p.created_at)}${p.updated_at ? ` | updated ${day(p.updated_at)}` : ''}`);
    if (r.doc_no) {
      const all = await sql`SELECT * FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${r.doc_no} ORDER BY paid_at, created_at`;
      for (const p of all) {
        const [o] = await sql`SELECT or_number, status, amount_sen FROM scm.acc_official_receipts WHERE payment_source = 'SOPAY' AND payment_id = ${String(p.id)}`;
        console.log(`SO|${r.doc_no} payment ${p.id} | paid ${day(p.paid_at)} | ${p.method} | RM ${rm(p.amount_sen)} | made ${day(p.created_at)} | receipt ${o ? `${o.or_number} ${o.status} RM ${rm(o.amount_sen)}` : '-'}`);
      }
      const [so] = await sql`SELECT to_jsonb(s) AS j FROM scm.mfg_sales_orders s WHERE s.doc_no = ${r.doc_no}`;
      if (so) {
        const j = so.j;
        console.log(`SO|${j.doc_no} status ${j.status} | ${j.debtor_name ?? '-'} | total RM ${rm(j.total_sen ?? j.grand_total_sen ?? 0)}`);
      }
      const log = await sql`
        SELECT * FROM scm.mfg_so_audit_log
         WHERE so_doc_no = ${r.doc_no} AND (action ILIKE '%PAYMENT%' OR source = 'amend' OR payment_id IS NOT NULL)
         ORDER BY created_at`;
      for (const l of log) {
        console.log(`LOG|${day(l.created_at)} | ${l.action} | ${l.source} | ${l.actor_name_snapshot ?? '-'} | payment ${l.payment_id ?? '-'}`
          + ` | ${JSON.stringify(l.field_changes)}${l.note ? ` | note ${l.note}` : ''}`);
      }
    }
  }
} finally {
  await sql.end();
}
