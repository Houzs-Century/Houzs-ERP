// Apply 2990's migration 0154 (purchase_consignment_* PO/GRN/PR clone) into the
// Houzs `scm` schema. All FK targets (suppliers/staff/warehouses/
// supplier_material_bindings/warehouse_racks) are uuid PKs in scm and every enum
// it needs (po_status/grn_status/purchase_return_status/currency_code/
// material_kind) already exists — verified by introspect-consignment-deps.mjs.
//
// Transactional: SET LOCAL search_path TO scm, public so the unqualified DDL +
// FK targets all resolve inside scm; any error rolls the whole thing back and
// leaves scm untouched.
//
//   node scripts/scm-schema/apply-0154-consignment.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

let ddl = readFileSync("scripts/scm-schema/consignment/0154_purchase_consignment_module.sql", "utf8");
// Drop the file's own BEGIN;/COMMIT; — we run it inside our own managed txn so
// SET LOCAL search_path applies to the whole body.
ddl = ddl.replace(/^\s*BEGIN\s*;\s*$/im, "").replace(/^\s*COMMIT\s*;\s*$/im, "");

const pcTables = [
  "purchase_consignment_orders", "purchase_consignment_order_items",
  "purchase_consignment_receives", "purchase_consignment_receive_items",
  "purchase_consignment_returns", "purchase_consignment_return_items",
];

try {
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO scm, public`);
    await tx.unsafe(ddl);
  });
  console.log("APPLIED 0154 into scm. Verifying tables ...");
  for (const t of pcTables) {
    const r = await sql`
      select count(*)::int c from information_schema.columns
      where table_schema='scm' and table_name=${t}`;
    console.log(`  scm.${t}: ${r[0].c ? r[0].c + " columns" : "MISSING"}`);
  }
} catch (err) {
  console.error("APPLY FAILED (rolled back):", String(err?.message || err).slice(0, 500));
  process.exitCode = 2;
}
await sql.end();
