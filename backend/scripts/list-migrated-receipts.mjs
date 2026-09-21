#!/usr/bin/env node
/* list-migrated-receipts — print, as JSON, every goods receipt (GRN) of a
 * company that was carried over from AutoCount and is not cancelled, with the
 * AutoCount PO / GR numbers it mirrors and its lines. The first half of
 * regenerating src/scm/lib/migrated-receipts-not-invoiced.generated.ts
 * (docs/bugs/0918, purchase-side mirror);
 * export-migrated-receipts-not-invoiced.py is the second half. The PURCHASE-side
 * counterpart of list-migrated-deliveries.mjs.
 *
 * READ-ONLY: SELECTs inside one read-only transaction. Writes nothing.
 *
 * RE-RUN: prints the list as the database holds it now.
 *
 * Usage:  node scripts/list-migrated-receipts.mjs > migrated-receipts.json
 * Env:    DATABASE_URL (required)  COMPANY_ID (default 1)
 */
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
try {
  const { receipts, lines } = await sql.begin("read only", async (tx) => {
    /* book_no is the AutoCount GOODS RECEIPT number (linked_ac_gr_docno) — the
       number the python checks for a purchase-invoice transfer. po_no
       (linked_ac_docno) is the AutoCount PURCHASE ORDER number, carried for
       reference only. */
    const receipts = await tx`
      SELECT grn_number,
             linked_ac_gr_docno AS book_no,
             linked_ac_docno    AS po_no
        FROM scm.grns
       WHERE company_id = ${CO} AND migrated_no_stock AND status::text <> 'CANCELLED'
       ORDER BY grn_number`;
    const lines = await tx`
      SELECT g.grn_number, i.item_code, i.qty_accepted::float8 AS qty
        FROM scm.grns g
        JOIN scm.grn_items i ON i.grn_id = g.id
       WHERE g.company_id = ${CO} AND g.migrated_no_stock AND g.status::text <> 'CANCELLED'
       ORDER BY g.grn_number, i.id`;
    return { receipts, lines };
  });
  const linesByGrn = new Map();
  for (const l of lines) {
    const arr = linesByGrn.get(l.grn_number) ?? [];
    arr.push({ itemCode: l.item_code, qty: l.qty });
    linesByGrn.set(l.grn_number, arr);
  }
  process.stdout.write(JSON.stringify({
    companyId: CO,
    listedAt: new Date().toISOString(),
    receipts: receipts.map((r) => ({ ...r, lines: linesByGrn.get(r.grn_number) ?? [] })),
  }));
} finally {
  await sql.end();
}
