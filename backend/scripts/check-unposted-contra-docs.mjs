#!/usr/bin/env node
// check-unposted-contra-docs.mjs — READ-ONLY. For the documents whose LAST void
// left a contra unposted and no live posting behind (check-unposted-contras.mjs,
// 2026-10-20: HC-API-2609-002, HC-API-2610-033, SO payment c73792c4-…), is the
// document itself gone (cancelled / deleted)? Then the books are right to carry
// nothing. If it is still live, the books are missing it.
//
// Writes nothing. Env: DATABASE_URL.
//   npx tsx scripts/check-unposted-contra-docs.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });

try {
  const ap = await sql`
    SELECT company_id, invoice_number, status, total_sen FROM scm.ap_invoices
     WHERE invoice_number IN ('HC-API-2609-002', 'HC-API-2610-033')`;
  for (const r of ap) console.log(`AP ${r.invoice_number} (co ${r.company_id}): status ${r.status}, total RM ${rm(r.total_sen)}`);
  if (ap.length < 2) console.log(`AP rows found: ${ap.length} of 2`);
  const pay = await sql`
    SELECT id::text AS id, so_doc_no, amount_sen, method, paid_at::text AS paid_at, company_id
      FROM scm.mfg_sales_order_payments WHERE id::text = 'c73792c4-7926-4588-a457-8f9b91bf4a27'`;
  if (pay.length === 0) console.log('SO payment c73792c4-…: no row (deleted)');
  for (const p of pay) console.log(`SO payment ${p.id} (co ${p.company_id}) on ${p.so_doc_no}: RM ${rm(p.amount_sen)} ${p.method} paid ${p.paid_at}`);
  const je = await sql`
    SELECT je_no, source_type, posted, reversed, narration FROM scm.journal_entries
     WHERE source_doc_no IN ('HC-API-2609-002', 'HC-API-2610-033', 'c73792c4-7926-4588-a457-8f9b91bf4a27')
     ORDER BY source_doc_no, created_at`;
  for (const j of je) console.log(`  ${j.je_no} ${j.source_type} posted=${j.posted} reversed=${j.reversed} — ${(j.narration ?? '').slice(0, 90)}`);
} finally {
  await sql.end();
}
