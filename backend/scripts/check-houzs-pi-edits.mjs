#!/usr/bin/env node
/* check-houzs-pi-edits.mjs — READ ONLY. For the ERP purchase invoices whose
   amount differs from AutoCount's own (owner 2026-10-28: 「帮我检查autocount 和
   erp amount 不一样的，好像还有一些两边价钱不一样」): each one's lines — those
   carried over from AutoCount (an AutoCount line key) and those added in the
   ERP — and every change people made to it in the ERP (the audit trail), so a
   difference reads as either "the copy never carried all of AutoCount's lines"
   or "someone changed a price / added a line here".
   Env: DATABASE_URL, COMPANY_ID (1), DOCS (comma list of invoice numbers).
   One JSON line per invoice: PIX|{...}. Writes nothing. */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = String(process.env.DOCS || '').split(',').map((s) => s.trim()).filter(Boolean);

async function main() {
  if (String(process.env.MODE || 'plan') !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!DOCS.length) { console.error('DOCS is empty'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const pis = await sql`SELECT id, invoice_number, total_sen, created_at FROM scm.purchase_invoices WHERE company_id = ${CO} AND invoice_number = ANY(${DOCS}::text[])`;
    const ids = pis.map((p) => p.id);
    const items = ids.length ? await sql`SELECT purchase_invoice_id, item_code, material_name, description, qty, unit_price_sen, line_total_sen, linked_ac_dtlkey, created_at
        FROM scm.purchase_invoice_items WHERE purchase_invoice_id = ANY(${ids}::uuid[]) ORDER BY purchase_invoice_id, created_at` : [];
    const audit = await sql`SELECT entity_doc_no, action, actor_name_snapshot, source, created_at, note, field_changes FROM scm.entity_audit_log
        WHERE company_id = ${CO} AND entity_type = 'PURCHASE_INVOICE' AND entity_doc_no = ANY(${DOCS}::text[]) ORDER BY created_at`;
    for (const p of pis) {
      const ls = items.filter((i) => i.purchase_invoice_id === p.id);
      const edits = audit.filter((a) => a.entity_doc_no === p.invoice_number && a.actor_name_snapshot !== 'Opening import (AutoCount 31/08)');
      console.log(`PIX|${JSON.stringify({
        no: p.invoice_number, total: Number(p.total_sen), created: p.created_at,
        lines: ls.map((l) => ({ item: l.item_code ?? l.material_name, desc: l.description, qty: Number(l.qty), unit: Number(l.unit_price_sen), sen: Number(l.line_total_sen), ac: l.linked_ac_dtlkey != null })),
        edits: edits.map((a) => ({ by: a.actor_name_snapshot, at: a.created_at, action: a.action, source: a.source, note: String(a.note ?? '').slice(0, 160), changes: a.field_changes })),
      })}`);
    }
    for (const d of DOCS) if (!pis.some((p) => p.invoice_number === d)) console.log(`PIX|${JSON.stringify({ no: d, missing: true })}`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
