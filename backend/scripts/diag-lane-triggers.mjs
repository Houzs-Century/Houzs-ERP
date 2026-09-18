#!/usr/bin/env node
/* diag-lane-triggers — what fires on the tables the DO / SI / PI lane would
 * write, read from the LIVE database.
 *
 * The owner's standing rule is 「库存先不看」: if a write would move an on-hand
 * figure, stop and name the figure. Every repair this lane can reach writes a
 * LINK or a VARIANT column — never a quantity, never money — so the only way
 * one of them becomes a stock move is a trigger on the target table. Reading
 * the source cannot answer that: a trigger is a database object and this repo
 * has already paid for treating a migration file as evidence about production
 * (CLAUDE.md, "Reading code is not evidence about production").
 *
 * READ-ONLY. Two catalogue SELECTs, one connection.
 *
 * It PRINTS rather than gates. The gate belongs in each repair script at apply
 * time, against the tables that repair actually writes — repair-pi-gr-links.mjs
 * already refuses on scm.purchase_invoice_items and scm.grn_items. This is the
 * survey that says which repairs are even worth planning.
 */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }

/* The tables this lane could conceivably write, and the ones it must PROVE it
   does not disturb. The goods-receipt and purchase-order tables are in the list
   precisely because they are the PARALLEL lane's, and a trigger reaching them
   from one of our writes is the control this lane is held to. */
const TABLES = [
  "delivery_orders", "delivery_order_items",
  "sales_invoices", "sales_invoice_items",
  "purchase_invoices", "purchase_invoice_items",
  "grns", "grn_items",
  "purchase_orders", "purchase_order_items",
  "mfg_sales_orders", "mfg_sales_order_items",
  "inventory_movements",
];

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
try {
  const rows = await sql`
    SELECT c.relname AS table_name, t.tgname AS trigger_name,
           p.proname AS function_name, t.tgenabled::text AS enabled,
           pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal
       AND n.nspname = 'scm'
       AND c.relname = ANY(${TABLES})
     ORDER BY c.relname, t.tgname`;

  console.log(`\n=== TRIGGERS on scm tables this lane touches or must not disturb (${rows.length}) ===`);
  if (!rows.length) {
    console.log("   none. A pointer write on any of these tables cannot become a quantity move by trigger.");
  }
  let current = "";
  for (const r of rows) {
    if (r.table_name !== current) { current = r.table_name; console.log(`\n  scm.${current}`); }
    console.log(`    ${r.trigger_name}  fn=${r.function_name}  enabled=${r.enabled}`);
    console.log(`      ${r.def}`);
  }

  /* A table with no trigger can still be reached by a RULE. Cheap to ask, and
     the honest survey asks it rather than implying triggers are the only path. */
  const rules = await sql`
    SELECT c.relname AS table_name, r.rulename
      FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'scm' AND c.relname = ANY(${TABLES}) AND r.rulename <> '_RETURN'
     ORDER BY 1, 2`;
  console.log(`\n=== REWRITE RULES on the same tables (${rules.length}) ===`);
  for (const r of rules) console.log(`   scm.${r.table_name}  ${r.rulename}`);
  if (!rules.length) console.log("   none.");
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
}
await sql.end({ timeout: 5 });
