#!/usr/bin/env node
/* check-houzs-pi-copy.mjs — READ ONLY. One brought-over AutoCount purchase
   invoice copy against what AutoCount says now (owner 2026-10-28: 「帮我检查这一张」
   — DGSIZ26001656 / PI-007957: the ERP copy reads RM 3,400, AutoCount's PI
   listing and 31/08 aging RM 2,600). Prints the copy, its lines and the goods
   receipts they mirror, every other paper naming the same receipts or orders,
   the opening bill that replaced it and the vouchers that tick either.
   Env: DATABASE_URL, COMPANY_ID (1), DOC (HC-PI-007957). Writes nothing. */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const DOC = String(process.env.DOC || 'HC-PI-007957');
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const pick = (r, keys) => Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]]));

async function main() {
  if (String(process.env.MODE || 'plan') !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    if (process.env.ACCOUNTS) {
      const acc = await sql`SELECT account_code, account_name, parent_code FROM scm.accounts WHERE company_id = ${CO} AND account_code LIKE ${process.env.ACCOUNTS + '%'} ORDER BY 1`;
      for (const x of acc) out(`account ${x.account_code} ${x.account_name}${x.parent_code ? ` (under ${x.parent_code})` : ''}`);
    }
    const pi = await sql`SELECT * FROM scm.purchase_invoices WHERE company_id = ${CO} AND invoice_number = ${DOC}`;
    if (!pi.length) { out(`${DOC}: not found`); return; }
    const p = pi[0];
    out(`copy ${JSON.stringify(pick(p, ['invoice_number', 'linked_ac_docno', 'supplier_invoice_ref', 'invoice_date', 'total_sen', 'paid_sen', 'status', 'migrated_no_stock', 'created_at', 'updated_at', 'notes']))}`);
    const items = await sql`SELECT * FROM scm.purchase_invoice_items WHERE purchase_invoice_id = ${p.id} ORDER BY 1`;
    const keys = ['line_no', 'item_code', 'description', 'qty', 'unit_price_sen', 'unit_cost_sen', 'line_total_sen', 'total_sen', 'amount_sen', 'grn_id', 'grn_number', 'po_id', 'po_number', 'po_doc_no', 'linked_ac_dtlkey', 'notes'];
    for (const it of items) out(`line ${JSON.stringify(pick(it, keys))}`);
    out(`line columns: ${items[0] ? Object.keys(items[0]).join(',') : '-'}`);
    const grnIds = [...new Set(items.map((i) => i.grn_id).filter(Boolean))];
    if (grnIds.length) {
      const grns = await sql`SELECT * FROM scm.grns WHERE id = ANY(${grnIds}::uuid[])`;
      for (const g of grns) out(`grn ${JSON.stringify(pick(g, ['grn_number', 'linked_ac_docno', 'po_number', 'po_doc_no', 'received_date', 'status', 'total_sen', 'notes']))}`);
      const others = await sql`SELECT DISTINCT x.invoice_number, x.linked_ac_docno, x.total_sen, x.status::text AS status, x.invoice_date::text AS d
          FROM scm.purchase_invoice_items i JOIN scm.purchase_invoices x ON x.id = i.purchase_invoice_id
          WHERE i.grn_id = ANY(${grnIds}::uuid[]) AND x.id <> ${p.id}`;
      for (const o of others) out(`other PI on the same receipts: ${o.invoice_number} (${o.linked_ac_docno ?? '-'}) ${rm(o.total_sen)} ${o.status} ${o.d}`);
    }
    const api = await sql`SELECT a.id, a.invoice_number, a.total_sen, a.paid_sen, a.status, a.notes FROM scm.ap_invoices a
        WHERE a.company_id = ${CO} AND a.opening AND a.supplier_invoice_ref = ${p.supplier_invoice_ref}`;
    for (const a of api) out(`opening bill ${a.invoice_number} ${rm(a.total_sen)} paid ${rm(a.paid_sen)} ${a.status} — ${String(a.notes ?? '').slice(0, 120)}`);
    const ticks = await sql`SELECT v.pv_number, v.status::text AS status, v.voucher_date::text AS d, v.total_sen, a.amount_sen, a.applied_sen, coalesce(pi.invoice_number, ap.invoice_number) AS bill
        FROM scm.pv_allocations a JOIN scm.payment_vouchers v ON v.id = a.pv_id
        LEFT JOIN scm.purchase_invoices pi ON pi.id = a.pi_id LEFT JOIN scm.ap_invoices ap ON ap.id = a.ap_invoice_id
        WHERE a.pi_id = ${p.id} OR a.ap_invoice_id = ANY(${api.map((x) => x.id)}::uuid[])`;
    for (const t of ticks) out(`tick ${t.pv_number} ${t.status} ${t.d} → ${t.bill} planned ${rm(t.amount_sen)} applied ${rm(t.applied_sen)} (voucher total ${rm(t.total_sen)})`);
    const audit = await sql`SELECT action, actor_name_snapshot, created_at, note, field_changes FROM scm.entity_audit_log WHERE company_id = ${CO} AND entity_doc_no = ${DOC} ORDER BY created_at`;
    for (const a of audit) out(`audit ${a.action} ${a.actor_name_snapshot ?? '-'} ${a.created_at?.toISOString?.() ?? a.created_at} ${JSON.stringify(a.field_changes).slice(0, 160)} ${String(a.note ?? '').slice(0, 120)}`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
