#!/usr/bin/env node
// check-receipt-names.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09, printing an official receipt the catch-up made formal: "Confirmed:
// Claude, for the owner (2026-11-09) — matched in …" 是什么东西 / 为甚没有name 这些.
// Prints: today's catch-up receipts (issued_by starting "Claude, for the owner"), how many
// lack a customer name; receipts of every status without a customer name, per company and
// status, with what their order / invoice says the customer is; and the receipt of
// 2990-SO-2608-040's 04/11 payment as stored.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);

await sql.begin('READ ONLY', async (tx) => {
  const [mine] = await tx`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE COALESCE(btrim(customer_name), '') = '')::int AS nameless
      FROM scm.acc_official_receipts WHERE issued_by LIKE 'Claude, for the owner%'`;
  out(`catch-up receipts: ${mine.n}, without a customer name: ${mine.nameless}`);
  for (const r of await tx`
    SELECT company_id, status, payment_source, count(*)::int AS n,
           count(*) FILTER (WHERE COALESCE(btrim(customer_name), '') = '')::int AS nameless
      FROM scm.acc_official_receipts GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`) {
    out(`co${r.company_id} ${r.status} ${r.payment_source}: ${r.n} receipts, ${r.nameless} without a name`);
  }
  out('── nameless receipts and what their order / invoice names (first 12)');
  for (const r of await tx`
    SELECT r.company_id, r.or_number, r.status, r.payment_source, r.doc_no, r.paid_at::text AS paid,
           o.debtor_name AS so_debtor, si.debtor_name AS si_debtor
      FROM scm.acc_official_receipts r
      LEFT JOIN scm.mfg_sales_orders o ON r.payment_source = 'SOPAY' AND o.doc_no = r.doc_no
      LEFT JOIN scm.sales_invoices si ON r.payment_source = 'SIPAY' AND si.id::text = r.doc_no
     WHERE COALESCE(btrim(r.customer_name), '') = ''
     ORDER BY r.paid_at DESC NULLS LAST LIMIT 12`) {
    out(`co${r.company_id} ${r.or_number} ${r.status} ${r.payment_source} doc=${r.doc_no ?? '∅'} paid=${r.paid} → order says ${r.so_debtor ?? '∅'} / invoice says ${r.si_debtor ?? '∅'}`);
  }
  out('── the receipt of 2990-SO-2608-040 paid 04/11');
  for (const r of await tx`
    SELECT to_jsonb(r) AS j FROM scm.acc_official_receipts r
     WHERE r.payment_id = '6bae3f2f-f70a-4d54-944b-1d71c3c0a8e2'`) {
    const j = r.j;
    out(Object.entries(j).filter(([k]) => !/_id$|^id$/.test(k) || k === 'payment_id').map(([k, v]) => `${k}=${v === null ? '∅' : String(v).slice(0, 60)}`).join(' '));
  }
  const [so] = await tx`SELECT doc_no, debtor_name, debtor_code FROM scm.mfg_sales_orders WHERE doc_no = '2990-SO-2608-040'`;
  out(`order 2990-SO-2608-040: debtor_name=${so?.debtor_name ?? '∅'} debtor_code=${so?.debtor_code ?? '∅'}`);
});
await sql.end();
