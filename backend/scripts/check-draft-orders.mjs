#!/usr/bin/env node
// check-draft-orders.mjs — READ-ONLY. What a DRAFT sales order already is
// before anyone confirms it.
//
// WHY. The owner, 2026-10-16, on a scan draft that cannot be confirmed until its
// salesperson is put on a fair: 「那么这个订单会开吗？还没 confirm 时」 then
// 「确定一下现在的流程」. Answers it from the data for the company's live drafts:
// how many, how they were made (the CREATE audit row's source), how old, whether
// money is recorded on them, and whether that money is already in the books
// (a posted journal entry, source_type SOPAY, per payment).
//
// Writes nothing. Env: DATABASE_URL, COMPANY_ID (default 1).
//   npx tsx scripts/check-draft-orders.mjs

import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v).slice(0, 10));

try {
  const drafts = await sql`
    SELECT so.doc_no, so.so_date, so.created_at, so.fair_match, so.project_id, so.local_total_sen,
           (SELECT a.source FROM scm.mfg_so_audit_log a WHERE a.so_doc_no = so.doc_no AND a.action = 'CREATE' ORDER BY a.created_at LIMIT 1) AS made_by
      FROM scm.mfg_sales_orders so
     WHERE so.company_id = ${CO} AND so.status::text = 'DRAFT'
     ORDER BY so.so_date`;
  const docs = drafts.map((d) => d.doc_no);
  const pays = docs.length ? await sql`
    SELECT p.id::text AS id, p.so_doc_no, p.amount_sen, p.method::text AS method
      FROM scm.mfg_sales_order_payments p WHERE p.so_doc_no IN ${sql(docs)}` : [];
  const posted = pays.length ? await sql`
    SELECT source_doc_no FROM scm.journal_entries
     WHERE source_type = 'SOPAY' AND posted = true AND source_doc_no IN ${sql(pays.map((p) => p.id))}` : [];
  const postedSet = new Set(posted.map((r) => r.source_doc_no));

  const t = {};
  const bump = (k) => { t[k] = (t[k] ?? 0) + 1; };
  for (const d of drafts) {
    bump(`made by ${d.made_by ?? '?'}`);
    bump(`fair: ${d.project_id != null ? 'linked' : (d.fair_match ?? 'NULL')}`);
    const mine = pays.filter((p) => p.so_doc_no === d.doc_no);
    bump(mine.length ? 'has payments' : 'no payments');
  }
  console.log(`company ${CO}: live DRAFT orders: ${drafts.length}; oldest ${day(drafts[0]?.so_date)}; newest ${day(drafts.at(-1)?.so_date)}`);
  for (const k of Object.keys(t).sort()) console.log(`  ${k} — ${t[k]}`);
  console.log(`payments on drafts: ${pays.length}; with a POSTED journal entry: ${pays.filter((p) => postedSet.has(p.id)).length}; RM ${Math.round(pays.reduce((s, p) => s + Number(p.amount_sen ?? 0), 0) / 100).toLocaleString('en-MY')}`);
  console.log(`by method: ${JSON.stringify(pays.reduce((m, p) => ({ ...m, [p.method]: (m[p.method] ?? 0) + 1 }), {}))}`);
} finally {
  await sql.end();
}
