#!/usr/bin/env node
/* list-migrated-deliveries — print, as JSON, every delivery order of a company
 * that was carried over from AutoCount and is not cancelled, with the AutoCount
 * number it mirrors. The first half of regenerating
 * src/scm/lib/migrated-deliveries-not-invoiced.generated.ts (docs/bugs/0918);
 * export-migrated-deliveries-not-invoiced.py is the second half.
 *
 * READ-ONLY: one SELECT inside a read-only transaction. Writes nothing.
 *
 * RE-RUN: prints the list as the database holds it now.
 *
 * Usage:  node scripts/list-migrated-deliveries.mjs > migrated-deliveries.json
 * Env:    DATABASE_URL (required)  COMPANY_ID (default 1)
 */
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
try {
  const rows = await sql.begin("read only", (tx) => tx`
    SELECT do_number, linked_ac_docno AS book_no
      FROM scm.delivery_orders
     WHERE company_id = ${CO} AND migrated_no_stock AND status::text <> 'CANCELLED'
     ORDER BY do_number`);
  process.stdout.write(JSON.stringify({ companyId: CO, listedAt: new Date().toISOString(), deliveries: [...rows] }));
} finally {
  await sql.end();
}
