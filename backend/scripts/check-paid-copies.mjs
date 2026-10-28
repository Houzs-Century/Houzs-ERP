#!/usr/bin/env node
// check-paid-copies.mjs — READ ONLY. Houzs 31/08 opening: which brought-over
// (migrated) purchase invoices already carry money in the ERP — voucher ticks,
// credit-note knock-offs — and from which documents, so the opening never leaves
// a bill open twice. Writes nothing. Env: DATABASE_URL; COMPANY_ID.
import postgres from 'postgres';
const CO = Number(process.env.COMPANY_ID || 1);
async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const cols = new Set((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'pv_allocations'`).map((r) => r.column_name));
    console.log(`INFO|pv_allocations columns: ${[...cols].join(', ')}`);
    const amt = cols.has('applied_sen') ? 'a.applied_sen' : cols.has('amount_sen') ? 'a.amount_sen' : 'a.amount_centi';
    const pvs = await sql.unsafe(`SELECT p.invoice_number, p.linked_ac_docno, p.total_sen, p.paid_sen, p.status::text AS status, p.invoice_date::text AS date,
        v.pv_number, v.voucher_date::text AS pv_date, v.status::text AS pv_status, a.amount_sen AS planned, ${amt} AS sen
      FROM scm.purchase_invoices p JOIN scm.pv_allocations a ON a.pi_id = p.id JOIN scm.payment_vouchers v ON v.id = a.pv_id
      WHERE p.company_id = $1 AND p.migrated_no_stock ORDER BY p.invoice_number`, [CO]);
    for (const r of pvs) console.log(`PV|${JSON.stringify(r)}`);
    const cns = await sql`SELECT p.invoice_number, n.note_number, n.note_date::text AS date, n.status, a.applied_sen
      FROM scm.purchase_invoices p JOIN scm.acc_credit_note_allocations a ON a.purchase_invoice_id = p.id JOIN scm.acc_credit_notes n ON n.id = a.note_id
      WHERE p.company_id = ${CO} AND p.migrated_no_stock ORDER BY 1`;
    for (const r of cns) console.log(`CN|${JSON.stringify(r)}`);
    const paid = await sql`SELECT invoice_number, linked_ac_docno, total_sen, paid_sen, status::text AS status, invoice_date::text AS date, left(coalesce(notes, ''), 160) AS notes
      FROM scm.purchase_invoices WHERE company_id = ${CO} AND migrated_no_stock AND paid_sen > 0 ORDER BY 1`;
    for (const r of paid) console.log(`PAID|${JSON.stringify(r)}`);
    const audit = await sql`SELECT entity_doc_no, action, actor_name_snapshot, source, created_at::text AS at, left(coalesce(note, ''), 120) AS note, field_changes::text AS ch
      FROM scm.entity_audit_log WHERE company_id = ${CO} AND entity_type = 'PURCHASE_INVOICE' AND entity_doc_no = ANY(${paid.map((p) => p.invoice_number)}::text[]) ORDER BY created_at`;
    for (const r of audit) console.log(`AUDIT|${JSON.stringify({ ...r, ch: String(r.ch).slice(0, 200) })}`);
    console.log(`INFO|pv ticks ${pvs.length}, credit-note knock-offs ${cns.length}, copies with money ${paid.length}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
