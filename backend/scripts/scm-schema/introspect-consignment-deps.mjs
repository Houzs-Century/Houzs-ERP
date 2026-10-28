// Introspect the scm schema for everything 0154 (purchase_consignment_*) needs:
//   - PK column types of FK targets (suppliers, staff, warehouses,
//     supplier_material_bindings, warehouse_racks)
//   - which purchase_consignment_* tables already exist
//   - which enums 0154 references already exist in scm
//
//   node scripts/scm-schema/introspect-consignment-deps.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

const fkTargets = ["suppliers", "staff", "warehouses", "supplier_material_bindings", "warehouse_racks"];
const pcTables = [
  "purchase_consignment_orders", "purchase_consignment_order_items",
  "purchase_consignment_receives", "purchase_consignment_receive_items",
  "purchase_consignment_returns", "purchase_consignment_return_items",
];
const enums = ["po_status", "grn_status", "purchase_return_status", "currency_code", "material_kind"];

try {
  console.log("=== FK-target tables: existence + 'id' column type ===");
  for (const t of fkTargets) {
    const r = await sql`
      select column_name, data_type, udt_name
      from information_schema.columns
      where table_schema='scm' and table_name=${t} and column_name='id'`;
    if (!r.length) {
      const exists = await sql`select 1 from information_schema.tables where table_schema='scm' and table_name=${t}`;
      console.log(`  ${t}: ${exists.length ? "EXISTS but no 'id' col" : "MISSING TABLE"}`);
    } else {
      console.log(`  ${t}.id -> ${r[0].data_type} (udt=${r[0].udt_name})`);
    }
  }

  console.log("\n=== purchase_consignment_* tables present in scm? ===");
  for (const t of pcTables) {
    const r = await sql`select 1 from information_schema.tables where table_schema='scm' and table_name=${t}`;
    console.log(`  ${t}: ${r.length ? "EXISTS" : "missing"}`);
  }

  console.log("\n=== enums present in scm? (+ labels) ===");
  for (const e of enums) {
    const r = await sql`
      select e.enumlabel
      from pg_type t join pg_namespace n on n.oid=t.typnamespace
      join pg_enum e on e.enumtypid=t.oid
      where n.nspname='scm' and t.typname=${e}
      order by e.enumsortorder`;
    console.log(`  ${e}: ${r.length ? r.map(x => x.enumlabel).join(", ") : "MISSING"}`);
  }
} catch (err) {
  console.error("INTROSPECT FAILED:", String(err?.message || err).slice(0, 400));
  process.exitCode = 2;
}
await sql.end();
