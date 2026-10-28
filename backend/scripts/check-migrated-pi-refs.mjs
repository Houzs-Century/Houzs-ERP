#!/usr/bin/env node
// check-migrated-pi-refs.mjs — READ ONLY. Houzs 31/08 opening: the AutoCount
// creditor aging names each bill by the SUPPLIER's invoice number; the ERP's
// migrated purchase invoices carry AutoCount's PI number. Where, if anywhere, do
// the migrated rows keep the supplier's number (notes, the goods receipt, the PO)?
// Prints every purchase invoice of the company dated up to TO with what could
// carry it. Writes nothing. Env: DATABASE_URL; COMPANY_ID; TO.
import postgres from 'postgres';
const CO = Number(process.env.COMPANY_ID || 1);
const TO = process.env.TO || '2026-08-31';
async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const gcols = new Set((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'grns'`).map((r) => r.column_name));
    const refCols = ['supplier_do_no', 'supplier_invoice_no', 'supplier_ref', 'do_number', 'ref', 'remarks', 'notes', 'linked_ac_docno', 'grn_number', 'received_date', 'grn_date'].filter((c) => gcols.has(c));
    console.log(`INFO|grns ref columns: ${refCols.join(', ')}`);
    const rows = await sql.unsafe(`SELECT p.invoice_number, p.linked_ac_docno, p.supplier_invoice_ref, p.invoice_date::text AS date, s.code AS supplier,
        p.total_sen, p.paid_sen, p.status::text AS status, p.migrated_no_stock, left(coalesce(p.notes, ''), 120) AS notes,
        ${refCols.map((c) => `g.${c}::text AS g_${c}`).join(', ') || 'NULL AS g_none'}
      FROM scm.purchase_invoices p LEFT JOIN scm.suppliers s ON s.id = p.supplier_id LEFT JOIN scm.grns g ON g.id = p.grn_id
      WHERE p.company_id = $1 AND p.invoice_date <= $2 ORDER BY p.invoice_date, p.invoice_number`, [CO, TO]);
    for (const r of rows) console.log(`PI|${JSON.stringify(r)}`);
    console.log(`INFO|rows ${rows.length}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
