// probe-fabric-accessory-schema — READ-ONLY. Columns of the tables the Sofa
// Accessory recategorisation touches, and the ledger rows for those SKUs, so
// the data run is written against the live shape rather than a guess.
// RE-RUN: idempotent, SELECT only.
import postgres from "postgres";
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 60 });
const say = (m = "") => console.log(m);
try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; } catch { /* SELECT only */ }
const T = ["mfg_sales_order_items", "purchase_order_items", "grn_items", "delivery_order_items", "purchase_invoice_items", "sales_invoice_items",
  "inventory_lots", "inventory_movements", "inventory_lot_consumptions", "stock_take_lines", "grns", "delivery_orders", "purchase_invoices", "sales_invoices", "purchase_orders", "mfg_sales_orders"];
for (const t of T) {
  const c = await sql`SELECT column_name::text AS c, data_type::text AS d FROM information_schema.columns WHERE table_schema='scm' AND table_name=${t} ORDER BY ordinal_position`;
  say(`${t}: ${c.map((r) => r.c).join(", ")}`);
}
const CODES = ["SQUARE PILLOW", "LONG PILLOW", "AR01", "AR02", "BC04", "BC04-MF", "BC05", "BC05-MF", "SB02"];
say("\n=== lots ===");
for (const r of await sql`SELECT * FROM scm.inventory_lots WHERE upper(btrim(item_code)) = ANY(${CODES}) ORDER BY item_code, created_at`) say(JSON.stringify(r));
say("\n=== movements ===");
for (const r of await sql`SELECT * FROM scm.inventory_movements WHERE upper(btrim(item_code)) = ANY(${CODES}) ORDER BY item_code, created_at`) say(JSON.stringify(r));
say("\n=== consumptions ===");
for (const r of await sql`SELECT * FROM scm.inventory_lot_consumptions WHERE upper(btrim(item_code)) = ANY(${CODES}) ORDER BY item_code`) say(JSON.stringify(r));
say("\n=== acc bindings ===");
for (const r of await sql`SELECT * FROM scm.acc_item_group_accounts WHERE group_code IN ('ACCESSORY','FABRIC_ACCESSORY')`) say(JSON.stringify(r));
say("READ-ONLY — nothing was written.");
await sql.end();
