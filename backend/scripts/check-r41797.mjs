#!/usr/bin/env node
// check-r41797.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// The AEON swipe R41797, RM 3,990 on 05/11 at terminal 000458030287527: is its sale in the
// ERP in any shape? Orders of that total, payments that add up to it, unclaimed card money
// on those days, and what that terminal's other lines matched to.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => String(v ?? '').slice(0, 10);
const C = 1;
const TARGET = 399000;

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const orders = await tx`
    SELECT so.doc_no, so.created_at, so.local_total_sen, so.debtor_name, so.status, so.project_id
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${C} AND so.created_at >= '2026-10-25' AND so.created_at < '2026-11-08' AND so.local_total_sen = ${TARGET}
     ORDER BY so.created_at`;
  out(`orders opened 25/10-07/11 of total RM 3,990: ${orders.length}`);
  for (const o of orders) {
    const pays = await tx`SELECT paid_at, amount_sen, approval_code, method, merchant_provider FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${o.doc_no} ORDER BY paid_at`;
    out(`   ${o.doc_no} ${day(o.created_at)} ${String(o.debtor_name ?? '').slice(0, 26)} ${o.status} | ${pays.map((p) => `${day(p.paid_at)} ${rm(p.amount_sen)} ${p.method ?? '-'} ${p.merchant_provider ?? '-'} ${p.approval_code ?? '-'}`).join(' ; ') || 'no payment'}`);
  }
  const claimed = new Set((await tx`SELECT payment_id::text AS id FROM scm.acc_settlement_matches WHERE company_id = ${C}`).map((m) => m.id));
  const card = await tx`
    SELECT p.id::text AS id, p.so_doc_no, p.paid_at, p.amount_sen, p.approval_code, p.method, p.merchant_provider, so.debtor_name
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = p.so_doc_no
     WHERE p.company_id = ${C} AND p.paid_at >= '2026-11-01' AND p.paid_at <= '2026-11-08' AND p.method = 'merchant'
     ORDER BY p.paid_at`;
  const open = card.filter((p) => !claimed.has(p.id));
  out(`card payments dated 01-08/11: ${card.length}; no report line claims: ${open.length}`);
  for (const p of open.slice(0, 30)) out(`   ${day(p.paid_at)} ${p.so_doc_no} ${rm(p.amount_sen)} ${p.merchant_provider ?? '-'} code ${p.approval_code ?? '-'} | ${String(p.debtor_name ?? '').slice(0, 24)}`);
  /* Two or three unclaimed payments on one order, or across orders, making the amount. */
  const hits = [];
  for (let i = 0; i < open.length; i += 1) {
    for (let j = i + 1; j < open.length; j += 1) {
      const two = Number(open[i].amount_sen) + Number(open[j].amount_sen);
      if (two === TARGET) hits.push([open[i], open[j]]);
      for (let k = j + 1; k < open.length; k += 1) if (two + Number(open[k].amount_sen) === TARGET) hits.push([open[i], open[j], open[k]]);
    }
  }
  out(`unclaimed card payments that add up to RM 3,990: ${hits.length}`);
  for (const h of hits.slice(0, 6)) out(`   ${h.map((p) => `${p.so_doc_no} ${rm(p.amount_sen)} ${p.merchant_provider ?? '-'} ${day(p.paid_at)}`).join(' + ')}`);
  /* This terminal's history: which orders its confirmed lines belong to, so the fair is known. */
  const terminal = await tx`
    SELECT b.file_name, b.period_from, r.line_no, r.gross_sen, r.ref, r.bucket, r.confirmed_at, m.payment_id::text AS pid
      FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
      LEFT JOIN scm.acc_settlement_matches m ON m.settlement_row_id = r.id
     WHERE r.company_id = ${C} AND b.file_name ILIKE '%000458030287527%' ORDER BY b.period_from DESC, r.line_no LIMIT 14`;
  const ids = terminal.map((t) => t.pid).filter(Boolean);
  const paid = ids.length ? await tx`SELECT p.id::text AS id, p.so_doc_no, so.debtor_name, so.project_id, pr.name AS fair FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = p.so_doc_no LEFT JOIN public.projects pr ON pr.id = so.project_id WHERE p.id::text IN ${tx(ids)}` : [];
  const byId = new Map(paid.map((p) => [p.id, p]));
  out('that terminal, newest first:');
  for (const t of terminal) {
    const p = t.pid ? byId.get(t.pid) : null;
    out(`   ${day(t.period_from)} ${rm(t.gross_sen)} ${t.ref ?? '-'} ${t.confirmed_at ? 'confirmed' : t.bucket} ${p ? `${p.so_doc_no} ${String(p.debtor_name ?? '').slice(0, 20)} | ${String(p.fair ?? '-').slice(0, 50)}` : '-'}`);
  }
});
await sql.end();
