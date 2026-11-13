// Read-only probe, second pass: what fires when the rename writes, and the
// state of the documents it touches. One-off; dropped before merge.
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const out = (m) => console.log(m);
const cut = (s, n = 260) => { const v = String(s ?? ""); return v.length > n ? `${v.slice(0, n)}…` : v; };
const OLD = ["KN01", "KN02", "KN03", "KN04", "KN05", "KN06", "KN07", "KN08", "KN09", "KN10", "KN11", "KN12", "KN13"];
const OLD_RE = "(^|[^A-Za-z0-9])KN(0[1-9]|1[0-3])([^A-Za-z0-9]|$)";
const TABLES = ["mfg_sales_order_items", "purchase_order_items", "purchase_consignment_order_items",
  "purchase_consignment_receive_items", "inventory_lots", "inventory_movements", "product_models",
  "product_request_lines", "hr_item_kpi", "fabric_library", "fabric_colours", "fabric_trackings"];

async function section(title, fn) {
  out(`\n=== ${title} ===`);
  try { await fn(); } catch (e) { out(`  FAILED: ${cut(e.message, 300)}`); }
}
const dump = (rows, n = 900) => { out(`  ${rows.length} row(s)`); for (const r of rows) out(`  ${cut(JSON.stringify(r), n)}`); };

await section("1. triggers on every table the rename writes", async () => dump(await sql`
  SELECT c.relname AS t, tg.tgname, pg_get_triggerdef(tg.oid) AS def
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT tg.tgisinternal AND n.nspname = 'scm' AND c.relname = ANY(${TABLES}::text[])
   ORDER BY 1, 2`, 700));

await section("2. materialized views in scm / public", async () => dump(await sql`
  SELECT n.nspname AS s, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'm' AND n.nspname IN ('scm', 'public') ORDER BY 1, 2`));

await section("3. views whose definition reads inventory_lots / inventory_movements variant_key", async () => dump(await sql`
  SELECT schemaname || '.' || viewname AS v FROM pg_views
   WHERE schemaname IN ('scm', 'public') AND definition ILIKE '%variant_key%' ORDER BY 1`));

await section("4. Venture Portal feed scope", async () => dump(await sql`
  SELECT key, value FROM scm.app_config WHERE key = 'scm.venture_portal_feed'`));

await section("5. product request lines on the old codes, by request status", async () => dump(await sql`
  SELECT r.company_id, r.status, r.request_type, COUNT(DISTINCT r.id)::int AS requests, COUNT(*)::int AS lines,
         array_agg(DISTINCT l.fabric_code) AS codes, MIN(r.request_no) AS first_no, MAX(r.request_no) AS last_no
    FROM scm.product_request_lines l JOIN scm.product_requests r ON r.id = l.request_id
   WHERE l.fabric_code = ANY(${OLD}::text[])
   GROUP BY 1, 2, 3 ORDER BY 1, 2`));

await section("6. purchase orders that carry the old codes", async () => dump(await sql`
  SELECT h.company_id, h.po_number, h.status, COUNT(*)::int AS lines
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
   WHERE i.variants::text ~* ${OLD_RE} GROUP BY 1, 2, 3 ORDER BY 2`));

await section("7. purchase consignment orders / receives that carry the old codes", async () => {
  dump(await sql`
    SELECT i.company_id, COUNT(*)::int AS lines
      FROM scm.purchase_consignment_order_items i WHERE i.variants::text ~* ${OLD_RE} GROUP BY 1`);
  dump(await sql`SELECT to_jsonb(i) AS row FROM scm.purchase_consignment_order_items i WHERE i.variants::text ~* ${OLD_RE} LIMIT 2`, 1400);
  dump(await sql`
    SELECT i.company_id, COUNT(*)::int AS lines
      FROM scm.purchase_consignment_receive_items i WHERE i.variants::text ~* ${OLD_RE} GROUP BY 1`);
  dump(await sql`SELECT to_jsonb(i) AS row FROM scm.purchase_consignment_receive_items i WHERE i.variants::text ~* ${OLD_RE} LIMIT 2`, 1400);
});

await section("8. columns of the two consignment purchase line tables", async () => dump(await sql`
  SELECT table_name, string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
   WHERE table_schema = 'scm' AND table_name IN ('purchase_consignment_order_items', 'purchase_consignment_receive_items',
         'inventory_lots', 'inventory_movements', 'product_request_lines', 'product_requests')
   GROUP BY 1 ORDER BY 1`, 1600));

await section("9. inventory lots on the old codes", async () => dump(await sql`
  SELECT to_jsonb(l) AS row FROM scm.inventory_lots l WHERE l.variant_key ~* ${OLD_RE}`, 900));

await section("10. inventory movements on the old codes", async () => dump(await sql`
  SELECT to_jsonb(m) AS row FROM scm.inventory_movements m WHERE m.variant_key ~* ${OLD_RE}`, 900));

await section("11. where the old code sits inside scan_jobs.review and the mrp snapshots", async () => {
  for (const [t, c] of [["scm.scan_jobs", "review"], ["scm.mrp_snapshots", "result"], ["scm.mrp_list_snapshots", "result"]]) {
    const rows = await sql.unsafe(
      `SELECT substring(${c}::text from '.{0,160}[^A-Za-z0-9]KN(?:0[1-9]|1[0-3])[^A-Za-z0-9].{0,100}') AS around
         FROM ${t} WHERE ${c}::text ~* $1 LIMIT 3`, [OLD_RE]);
    out(`  ${t}.${c}:`);
    for (const r of rows) out(`    ${cut(r.around, 420)}`);
  }
  dump(await sql`SELECT to_jsonb(j) - 'review' - 'result' - 'extracted' AS row FROM scm.scan_jobs j WHERE j.review::text ~* ${OLD_RE}`, 900);
  dump(await sql`SELECT to_jsonb(s) - 'result' AS row FROM scm.mrp_snapshots s WHERE s.result::text ~* ${OLD_RE}`, 600);
  dump(await sql`SELECT to_jsonb(s) - 'result' AS row FROM scm.mrp_list_snapshots s WHERE s.result::text ~* ${OLD_RE}`, 600);
});

await section("12. other fabric_library ids of company 2 and the EM id in any company", async () => {
  dump(await sql`SELECT id, label, active, sort_order, sofa_tier, bedframe_tier FROM scm.fabric_library WHERE company_id = 2 ORDER BY sort_order, id`);
  dump(await sql`SELECT id, company_id FROM scm.fabric_library WHERE upper(btrim(id)) = 'EM'`);
});

await section("13. the unique indexes on hr_item_kpi and product_models", async () => dump(await sql`
  SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'scm' AND tablename IN ('hr_item_kpi', 'product_models', 'product_request_lines')`, 400));

await sql.end({ timeout: 5 });
