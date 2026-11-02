#!/usr/bin/env node
// check-stuck-payment-2.mjs — READ ONLY. The second look for the owner's
// 2026-11-02 question: the orders involved (status, totals), every payment on
// them in full, and what the two June journal entries the bank line and the
// merchant row are matched to belong to. Nothing is written.
// Env: DATABASE_URL, COMPANY_ID (2), SO_DOCS (comma list), JE_NOS (comma list).
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 2);
const DOCS = String(process.env.SO_DOCS || '').split(',').map((s) => s.trim()).filter(Boolean);
const JES = String(process.env.JE_NOS || '').split(',').map((s) => s.trim()).filter(Boolean);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const show = (r) => Object.entries(r).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
try {
  for (const doc of DOCS) {
    const [so] = await sql`SELECT doc_no, status, debtor_name, total_sen, created_at, linked_ac_docno FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${doc}`.catch(async () => sql`SELECT doc_no, status, debtor_name, created_at FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${doc}`);
    out(`== ${doc}: ${so ? show(so) : 'NOT FOUND'}`);
    const pays = await sql`SELECT * FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no = ${doc} ORDER BY paid_at, created_at`;
    for (const p of pays) {
      out(`  pay ${show(p)}`);
      const jes = await sql`SELECT je_no, entry_date, reversed FROM scm.journal_entries WHERE company_id = ${CO} AND source_type = 'SOPAY' AND source_doc_no = ${String(p.id)} ORDER BY id`;
      out(`    JE: ${jes.map((j) => `${j.je_no} ${String(j.entry_date instanceof Date ? j.entry_date.toISOString() : j.entry_date).slice(0, 10)} reversed=${j.reversed}`).join(' ; ') || 'none'}`);
      const sm = await sql`SELECT settlement_row_id, amount_sen FROM scm.acc_settlement_matches WHERE company_id = ${CO} AND payment_id = ${String(p.id)}`;
      if (sm.length) out(`    merchant links: ${sm.map((m) => `row ${m.settlement_row_id} ${m.amount_sen}`).join(' ; ')}`);
    }
  }
  for (const no of JES) {
    const [j] = await sql`SELECT je_no, entry_date, source_type, source_doc_no, description, reversed, posted FROM scm.journal_entries WHERE company_id = ${CO} AND je_no = ${no}`;
    out(`== ${no}: ${j ? show(j) : 'NOT FOUND'}`);
    if (j && ['SOPAY', 'SIPAY'].includes(String(j.source_type))) {
      const [p] = await sql`SELECT id, so_doc_no, method, merchant_provider, online_type, amount_sen, approval_code, paid_at, created_at FROM scm.mfg_sales_order_payments WHERE id::text = ${String(j.source_doc_no)}`;
      out(`   its payment: ${p ? show(p) : 'not an SO payment row (or gone)'}`);
    }
  }
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
