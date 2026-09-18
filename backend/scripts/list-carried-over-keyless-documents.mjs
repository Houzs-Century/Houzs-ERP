#!/usr/bin/env node
/* list-carried-over-keyless-documents — print, as JSON, the AutoCount numbers of
 * the delivery orders and purchase orders carried over from AutoCount that still
 * have a row with no AutoCount line key. The input for
 * export-ac-conversion-line-keys.py's CARRIED_OVER_FILE (docs/bugs/0919).
 *
 * A carried-over document is numbered "HC-" + its AutoCount number and links
 * that number; a delivery order is also flagged migrated_no_stock.
 *
 * READ-ONLY: SELECTs inside a read-only transaction. Writes nothing.
 * RE-RUN: prints the list as the database holds it now.
 *
 * Usage:  node scripts/list-carried-over-keyless-documents.mjs > carried-over.json
 * Env:    DATABASE_URL (required)  COMPANY_ID (default 1)
 */
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
try {
  const out = await sql.begin("read only", async (tx) => {
    const dos = await tx`
      SELECT DISTINCT d.linked_ac_docno AS book_no
        FROM scm.delivery_orders d JOIN scm.delivery_order_items i ON i.delivery_order_id = d.id
       WHERE d.company_id = ${CO} AND d.migrated_no_stock AND d.status::text <> 'CANCELLED'
         AND d.do_number = 'HC-' || d.linked_ac_docno AND i.linked_ac_dtlkey IS NULL
       ORDER BY 1`;
    const pos = await tx`
      SELECT DISTINCT p.linked_ac_docno AS book_no
        FROM scm.purchase_orders p JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
       WHERE p.company_id = ${CO} AND p.status::text <> 'CANCELLED'
         AND p.po_number = 'HC-' || p.linked_ac_docno AND i.linked_ac_dtlkey IS NULL
       ORDER BY 1`;
    return { DO: dos.map((r) => r.book_no), PO: pos.map((r) => r.book_no) };
  });
  process.stdout.write(JSON.stringify({ companyId: CO, listedAt: new Date().toISOString(), ...out }));
} finally {
  await sql.end();
}
