// ----------------------------------------------------------------------------
// check-merchant-line-sos.mjs — READ ONLY. One merchant-report line and the SO
// payments the owner says it is (2026-11-03: GHL 29/10 RM 5,000.00 =
// 2990-SO-2610-056 + 2990-SO-2610-055): the line, each payment's amount, day,
// method, acquirer, reference, and whether a settlement line already holds it.
// Writes nothing; MODE is ignored.
//
// Env: DATABASE_URL, REF (default 630214452663), SOS (default
// 2990-SO-2610-055,2990-SO-2610-056).
// ----------------------------------------------------------------------------

import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });
const ref = process.env.REF || '630214452663';
const sos = (process.env.SOS || '2990-SO-2610-055,2990-SO-2610-056').split(',').map((s) => s.trim());
const rm = (sen) => (sen == null ? '—' : (Number(sen) / 100).toFixed(2));
const d = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

try {
  const rows = await sql`
    select r.id, r.company_id, r.acquirer_code, r.batch_id, r.line_no, r.txn_date, r.ref, r.gross_sen
    from scm.acc_settlement_rows r where r.ref = ${ref}`;
  console.log('SETTLEMENT LINE(S)');
  for (const r of rows) console.log(`  row ${r.id} co ${r.company_id} ${r.acquirer_code} batch ${r.batch_id} line ${r.line_no} | ${d(r.txn_date)} | ${rm(r.gross_sen)}`);
  const pays = await sql`
    select p.id, p.company_id, p.so_doc_no, p.paid_at, p.amount_sen, p.method, p.merchant_provider, p.approval_code, p.account_sheet
    from scm.mfg_sales_order_payments p where p.so_doc_no in ${sql(sos)} order by p.so_doc_no, p.paid_at`;
  console.log('SO PAYMENTS');
  for (const p of pays) {
    const held = await sql`select m.settlement_row_id as row_id from scm.acc_settlement_matches m where m.payment_id::text = ${String(p.id)}`;
    console.log(`  ${p.so_doc_no} | pay ${p.id} | ${d(p.paid_at)} | ${rm(p.amount_sen)} | ${p.method} | provider ${p.merchant_provider ?? '—'} | ref ${p.approval_code ?? '—'} | sheet ${p.account_sheet ?? '—'} | held by row ${held.map((h) => h.row_id).join(',') || 'none'}`);
  }
  const sum = pays.reduce((s, p) => s + Number(p.amount_sen ?? 0), 0);
  console.log(`SUM of these payments: ${rm(sum)}`);
} finally {
  await sql.end();
}
