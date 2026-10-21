#!/usr/bin/env node
// check-merchant-tags.mjs — READ-ONLY. For one merchant's statements (ACQ,
// default PBB): which merchant name the swipes were keyed under on the Sales
// Orders, and (ROW_ID) everything about one matched line that will not post.
// Writes nothing. Env: DATABASE_URL, ACQ, COMPANY_ID (default 1), ROW_ID.
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const ACQ = process.env.ACQ || 'PBB';
const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '—' : String(v).slice(0, 10));

try {
  const lines = await sql`
    SELECT r.id, r.txn_date, r.ref, r.gross_sen, r.bucket, r.confirmed_at
      FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
     WHERE b.acquirer_code = ${ACQ} AND r.company_id = ${CO} AND r.txn_date >= '2026-09-01'`;
  const refs = [...new Set(lines.map((l) => String(l.ref ?? '').trim()).filter(Boolean))];
  const pays = refs.length === 0 ? [] : await sql`
    SELECT approval_code, merchant_provider, amount_sen FROM scm.mfg_sales_order_payments
     WHERE company_id = ${CO} AND approval_code IN ${sql(refs)}`;
  const byRef = new Map();
  for (const p of pays) byRef.set(String(p.approval_code).trim(), [...(byRef.get(String(p.approval_code).trim()) ?? []), p]);
  const verdict = new Map();
  for (const l of lines) {
    const hits = byRef.get(String(l.ref ?? '').trim()) ?? [];
    const same = hits.filter((h) => Number(h.amount_sen) === Number(l.gross_sen));
    const tag = hits.length === 0 ? 'no payment carries this code'
      : `${same.length > 0 ? 'same amount' : 'different amount'}, keyed ${[...new Set(hits.map((h) => h.merchant_provider ?? '(none)'))].join('/')}`;
    const k = `${l.bucket}${l.confirmed_at ? ' (confirmed)' : ''} — ${tag}`;
    verdict.set(k, (verdict.get(k) ?? 0) + 1);
  }
  console.log(`${ACQ} statement lines since 2026-09-01 (co ${CO}): ${lines.length}`);
  for (const [k, v] of [...verdict].sort()) console.log(`  ${v}× ${k}`);

  if (process.env.ROW_ID) {
    const id = Number(process.env.ROW_ID);
    const [row] = await sql`SELECT r.*, b.acquirer_code, b.file_name FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id WHERE r.id = ${id}`;
    console.log(`\nLine ${id}: ${JSON.stringify(row, (k, v) => (typeof v === 'bigint' ? Number(v) : v))}`);
    const links = await sql`SELECT * FROM scm.acc_settlement_matches WHERE settlement_row_id = ${id}`;
    console.log(`  its links: ${JSON.stringify(links)}`);
    const code = String(row?.ref ?? '').trim();
    const sameCode = await sql`
      SELECT p.id::text AS id, p.so_doc_no, p.paid_at, p.amount_sen, p.approval_code, p.method, p.merchant_provider, o.status
        FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no AND o.company_id = p.company_id
       WHERE p.company_id = ${CO} AND trim(p.approval_code) = ${code}`;
    for (const p of sameCode) {
      const claims = await sql`SELECT m.settlement_row_id, r.confirmed_at, b.acquirer_code, b.id AS batch_id FROM scm.acc_settlement_matches m JOIN scm.acc_settlement_rows r ON r.id = m.settlement_row_id JOIN scm.acc_settlement_batches b ON b.id = r.batch_id WHERE m.payment_id::text = ${p.id}`;
      console.log(`  payment ${p.so_doc_no} ${day(p.paid_at)} RM ${rm(p.amount_sen)} code ${p.approval_code} ${p.method} keyed ${p.merchant_provider ?? '—'} SO ${p.status ?? '—'} | already on: ${claims.map((c) => `${c.acquirer_code} #${c.batch_id} line ${c.settlement_row_id}${c.confirmed_at ? ' confirmed' : ''}`).join(', ') || 'nothing'}`);
    }
  }
} finally {
  await sql.end();
}
