#!/usr/bin/env node
// export-houzs-erp-bills.mjs — READ ONLY. Owner 2026-10-28: 「我只是有backfill 很多
// supplier 单，所以要确定那个我auto count的记录和erp 的记录有冲突吗？」. Every supplier
// bill the ERP holds for the company — purchase invoices (own and brought-over) and
// AP invoices — with when it was keyed and whether it is in the books, so they can
// be laid against AutoCount's 31/08 aging, its September GL and its PI listing.
// Writes nothing. Env: DATABASE_URL; COMPANY_ID.
import postgres from 'postgres';
const CO = Number(process.env.COMPANY_ID || 1);
async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const je = await sql`SELECT source_type, source_doc_no, entry_date::text AS d, total_debit_sen AS myr FROM scm.journal_entries
      WHERE company_id = ${CO} AND source_type IN ('PI', 'API') AND posted AND NOT reversed AND reversed_by_je IS NULL`;
    const jeBy = new Map(je.map((j) => [`${j.source_type}|${j.source_doc_no}`, j]));
    const pis = await sql`SELECT 'PI' AS k, p.invoice_number AS no, p.linked_ac_docno AS ac, p.supplier_invoice_ref AS ref, p.invoice_date::text AS date, s.code AS supplier,
        p.currency, p.exchange_rate::text AS rate, p.total_sen, p.paid_sen, p.status::text AS status, coalesce(p.migrated_no_stock, false) AS migrated,
        to_char(p.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS keyed, p.created_by::text AS by
      FROM scm.purchase_invoices p LEFT JOIN scm.suppliers s ON s.id = p.supplier_id WHERE p.company_id = ${CO}`;
    const apis = await sql`SELECT 'API' AS k, a.invoice_number AS no, NULL::text AS ac, a.supplier_invoice_ref AS ref, a.invoice_date::text AS date, s.code AS supplier,
        a.currency, a.exchange_rate::text AS rate, a.total_sen, a.paid_sen, a.status, false AS migrated,
        to_char(a.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS keyed, a.created_by AS by, left(coalesce(a.notes, ''), 120) AS notes
      FROM scm.ap_invoices a LEFT JOIN scm.suppliers s ON s.id = a.supplier_id WHERE a.company_id = ${CO}`;
    for (const r of [...pis, ...apis]) {
      const j = jeBy.get(`${r.k}|${r.no}`);
      console.log(`BILL|${JSON.stringify({ ...r, total_sen: Number(r.total_sen), paid_sen: Number(r.paid_sen), je: j ? { d: j.d, myr: Number(j.myr) } : null })}`);
    }
    console.log(`INFO|PI ${pis.length}, API ${apis.length}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
