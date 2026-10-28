// The drizzle-kit export of 2990's schema captured TABLES + ENUMS but NOT the
// views defined in the migration ledger (suppliers_with_derived_category,
// mfg_sales_orders_with_payment_totals, inventory/accounting/outstanding views,
// etc.). The ported SCM routes query those views, so without them the routes 500
// ("Could not find the table 'scm.<view>' in the schema cache").
//
// This script pulls every VIEW-creating migration from the 2990's repo (in
// numeric order so dependent views build after their sources), extracts ONLY the
// DROP/CREATE VIEW statements (skipping the table DDL those migrations also
// contain — already handled by the drizzle export), and applies each one
// INDIVIDUALLY into the scm schema (search_path = scm, public). Per-statement
// try/catch: a view that references a drifted column is logged + skipped instead
// of blocking the good ones.
//
//   node scripts/scm-schema/apply-scm-views.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const TWO990S_MIGRATIONS = "C:/Users/User/Desktop/2990s/packages/db/migrations";
// In numeric order — later migrations may CREATE OR REPLACE earlier views.
const FILES = [
  "0050_inventory_warehouses.sql",
  "0052_accounting_journal_entries.sql",
  "0053_inventory_fifo_cogs.sql",
  "0054_inventory_main_supplier.sql",
  "0059_outstanding_views.sql",
  "0076_so_list_view.sql",
  "0080_so_payment_totals_view_refresh.sql",
  "0082_locality_country.sql",
  "0086_user_mgmt.sql",
  "0088_suppliers_derived_category.sql",
  "0095_inventory_variant_key.sql",
  "0110_customer_credits.sql",
  "0122_lots_open_batch_no.sql",
  "0147_so_payment_totals_view_refresh_delivery_fee.sql",
  "0155_so_sku_p2_service_bucket_skus_deposit.sql",
];

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

// Pull DROP/CREATE VIEW statements (incl. MATERIALIZED) from a migration body,
// in file order. Split on ";\n" (same as pg-migrate), strip line comments, keep
// only view statements.
function extractViewStmts(body) {
  return body
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean)
    .filter((s) => /^(drop|create)\s+(or\s+replace\s+)?(materialized\s+)?view\b/i.test(s));
}

// Pull a stable view name out of a CREATE/DROP statement for logging.
function viewName(stmt) {
  const m = stmt.match(/view\s+(?:if\s+not\s+exists\s+|if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/i);
  return m ? m[1] : "(?)";
}

let created = 0, dropped = 0, failed = 0;
const fails = [];
try {
  // Set the session search_path so unqualified table refs inside the views
  // resolve to scm; views themselves are created in scm (first in path).
  await sql.unsafe(`SET search_path TO scm, public`);
  for (const f of FILES) {
    let body;
    try { body = readFileSync(`${TWO990S_MIGRATIONS}/${f}`, "utf8"); }
    catch { console.log(`  skip ${f} (not found)`); continue; }
    for (const stmt of extractViewStmts(body)) {
      const name = viewName(stmt);
      const isCreate = /^create/i.test(stmt);
      try {
        await sql.unsafe(stmt + ";");
        if (isCreate) { created++; } else { dropped++; }
      } catch (e) {
        failed++;
        fails.push(`${f} :: ${name} -> ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  }
  console.log(`views: ${created} created, ${dropped} dropped, ${failed} failed`);
  if (fails.length) {
    console.log("\nFAILURES (skipped — likely drift / out-of-scope):");
    for (const x of fails) console.log("  " + x);
  }
  // List what views now exist in scm.
  const v = await sql`select table_name from information_schema.views where table_schema='scm' order by table_name`;
  console.log(`\nscm now has ${v.length} views:`);
  console.log("  " + v.map((r) => r.table_name).join("\n  "));
} catch (err) {
  console.error("APPLY FAILED:", String(err?.message || err).slice(0, 300));
  process.exitCode = 2;
}
await sql.end();
