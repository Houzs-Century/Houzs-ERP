#!/usr/bin/env node
/* READ-ONLY: the owner's test order HC-SO-013393 — payments, variants, audit
 * trail, and whether anything was queued to AutoCount. */
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' });
const DOC = 'HC-SO-013393';
const h = await sql`SELECT doc_no, company_id, status::text AS st, local_total_sen, paid_sen, deposit_sen,
    balance_sen, linked_ac_docno, updated_at FROM scm.mfg_sales_orders WHERE doc_no=${DOC}`;
console.log('header:', JSON.stringify(h[0] ?? null));
const p = await sql`SELECT id, method, amount_sen, is_deposit, approval_code, created_at, updated_at
  FROM scm.mfg_sales_order_payments WHERE so_doc_no=${DOC} ORDER BY created_at`;
console.log(`payments: ${p.length}`);
for (const r of p) console.log(`   id=${r.id} ${r.method} ${(r.amount_sen/100).toFixed(2)} deposit=${r.is_deposit} approval=${r.approval_code ?? '-'} created=${r.created_at?.toISOString?.().slice(0,19)}`);
const items = await sql`SELECT line_no, item_code, item_group, qty, unit_price_sen, remark,
    (variants::text) AS v FROM scm.mfg_sales_order_items WHERE doc_no=${DOC} AND cancelled=false ORDER BY line_no NULLS LAST`;
console.log(`lines: ${items.length}`);
for (const r of items) console.log(`   ${r.line_no ?? '-'} ${r.item_code} [${r.item_group}] qty=${r.qty} remark=${(r.remark ?? '').slice(0,20)} variants=${(r.v ?? 'null').slice(0,120)}`);
const a = await sql`SELECT to_jsonb(t) AS j FROM scm.mfg_so_audit_log t
  WHERE t.so_doc_no=${DOC} ORDER BY t.created_at DESC LIMIT 6`;
console.log(`audit (newest ${a.length}):`);
for (const r of a) console.log('   ' + JSON.stringify(r.j).slice(0, 220));
const ob = await sql`SELECT to_jsonb(t) AS j FROM scm.autocount_outbox t
  WHERE t.doc_no LIKE ${'%013393%'} ORDER BY t.created_at DESC LIMIT 6`;
console.log(`autocount outbox rows for this doc: ${ob.length}`);
for (const r of ob) console.log('   ' + JSON.stringify(r.j).slice(0, 260));
const cfg = await sql`SELECT key, value::text AS v FROM scm.app_config WHERE key ILIKE '%autocount%' ORDER BY key`;
console.log('autocount switches:');
for (const r of cfg) console.log(`   ${r.key} = ${r.v}`);
await sql.end();
