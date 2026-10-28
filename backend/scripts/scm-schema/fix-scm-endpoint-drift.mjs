// Endpoint-level drift fixes found by the prod GET smoke test (2026-06-19).
// Four routes 500'd; all are DB-shape gaps the schema build missed:
//  1. stock_transfers FK constraint NAMES are drizzle-style
//     (stock_transfers_from_warehouse_id_warehouses_id_fk) but the route embeds
//     via the 2990 name (!stock_transfers_from_warehouse_id_fkey) — needed because
//     there are TWO FKs to warehouses so PostgREST must disambiguate by name.
//     Rename the constraints to the names the route expects.
//  2. mrp_category_lead_times table not built (migration 0099) — create + seed.
//  3/4. fabric_tier_addon_config + delivery_fee_config exist but have 0 rows; the
//     routes .single() on id=1 — seed the singleton (defaults fill the rest).
// Then NOTIFY pgrst to reload the schema cache (FK rename + new table).
//
//   node scripts/scm-schema/fix-scm-endpoint-drift.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

const log = (m) => console.log(m);

try {
  // 1. Rename the stock_transfers warehouse FKs to the names the route embeds.
  const renames = [
    ["stock_transfers_from_warehouse_id_warehouses_id_fk", "stock_transfers_from_warehouse_id_fkey"],
    ["stock_transfers_to_warehouse_id_warehouses_id_fk", "stock_transfers_to_warehouse_id_fkey"],
  ];
  for (const [from, to] of renames) {
    try {
      await sql.unsafe(`ALTER TABLE scm.stock_transfers RENAME CONSTRAINT "${from}" TO "${to}"`);
      log(`  renamed FK ${from} -> ${to}`);
    } catch (e) {
      log(`  FK ${from}: ${String(e?.message || e).slice(0, 70)}`);
    }
  }

  // 2. mrp_category_lead_times (migration 0099) — table + 5-category seed.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS scm.mrp_category_lead_times (
      category   text PRIMARY KEY CHECK (category IN ('sofa','bedframe','mattress','accessory','service')),
      lead_days  integer NOT NULL DEFAULT 0 CHECK (lead_days >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await sql.unsafe(`
    INSERT INTO scm.mrp_category_lead_times (category, lead_days) VALUES
      ('sofa',0),('bedframe',0),('mattress',0),('accessory',0),('service',0)
    ON CONFLICT (category) DO NOTHING`);
  log("  mrp_category_lead_times: created + seeded");

  // 3/4. Seed the singleton config rows (id=1; column defaults fill the rest).
  await sql.unsafe(`INSERT INTO scm.fabric_tier_addon_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await sql.unsafe(`INSERT INTO scm.delivery_fee_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  log("  fabric_tier_addon_config + delivery_fee_config: singleton row ensured");

  // Reload PostgREST so the FK rename + new table hit the schema cache.
  await sql.unsafe(`NOTIFY pgrst, 'reload schema'`);
  log("  NOTIFY pgrst reload sent");

  log("done.");
} catch (err) {
  console.error("FIX FAILED:", String(err?.message || err).slice(0, 300));
  process.exitCode = 2;
}
await sql.end();
