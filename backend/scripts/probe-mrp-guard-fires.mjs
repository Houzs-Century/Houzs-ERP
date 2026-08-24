#!/usr/bin/env node
/* Does computeMrp's truncation guard FIRE, or is it silent? Read-only.

   routes/mrp.ts:477 throws when the demand read RETURNS >= MRP_LOAD_CAP (5000).
   13,920 rows match that read's filters, so exactly one of these is true today:

     (a) PostgREST's db-max-rows is BELOW 5000 -> the read comes back short, the
         guard is silent, and the plan is computed over a slice;
     (b) db-max-rows is >= 5000 (or unset) -> the read returns exactly 5000, the
         guard THROWS, and GET /mrp is a 500 for everybody.

   probe-pgrest-max-rows established that a ceiling EXISTS (app reads with no
   .limit() still carry a generated LIMIT) but every LIMIT literal is normalised
   to $n by pg_stat_statements, so the ceiling's VALUE is not readable there.

   This settles it a different way — by CONTROL FLOW rather than by the number.
   The throw at :477 sits between the demand read and every later read in the
   same function. So if the reads that come AFTER it have been executed at all,
   the guard did not fire, and branch (a) holds. Each signature below is matched
   on a select-list that only computeMrp asks for, and the full statement is
   printed so a human can confirm the match rather than trust the LIKE.

   node scripts/probe-mrp-guard-fires.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* label, where-it-sits-in-computeMrp, LIKE patterns (ALL must match). */
const SIGS = [
  ['0 lead times      (BEFORE the guard)', ['%pgrst_source%', '%mrp_category_lead_times%']],
  ['1 DEMAND read     (the guarded read)', ['%pgrst_source%', '%mfg_sales_order_items%', '%line_delivery_date%', '%customer_delivery_date%']],
  ['1b soDeliverable  (AFTER the guard)', ['%pgrst_source%', '%mfg_sales_order_items%', '%special_order_price_sen%', '%line_suffix%']],
  ['2 product master  (AFTER the guard)', ['%pgrst_source%', '%mfg_products%', '%"code"%', '%"name"%', '%"category"%']],
  ['2b warehouses     (AFTER the guard)', ['%pgrst_source%', '%warehouses%', '%is_active%']],
  ['2c state mappings (AFTER the guard)', ['%pgrst_source%', '%state_warehouse_mappings%']],
  ['3 inventory_bal   (AFTER the guard)', ['%pgrst_source%', '%inventory_balances%', '%variant_key%', '%item_code%']],
  ['4 PO supply       (AFTER the guard)', ['%pgrst_source%', '%purchase_order_items%', '%supplier_delivery_date_4%']],
  ['5 bindings        (AFTER the guard)', ['%pgrst_source%', '%supplier_material_bindings%', '%is_main_supplier%']],
];

async function main() {
  note(`\n${'='.repeat(74)}`);
  note(`=== Does the mrp_load_truncated guard fire? (control flow, not row counts) ===`);

  const schema = await (async () => {
    const [r] = await sql`
      SELECT n.nspname AS s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pg_stat_statements'`;
    return r?.s ?? null;
  })();
  if (!schema) { note('  pg_stat_statements not installed — stopping'); await sql.end({ timeout: 5 }); return; }

  /* When did these counters start? Comparing call counts is only fair if the
     window is the same for all of them. */
  try {
    const [w] = await sql`
      SELECT min(stats_since)::text AS oldest, max(stats_since)::text AS newest
        FROM ${sql(schema)}.pg_stat_statements`;
    note(`  stats window: oldest entry ${w.oldest}, newest ${w.newest}`);
  } catch (e) { note(`  stats window: unavailable (${e.message})`); }

  note(`\n  step                                   statements | total calls`);
  const seen = [];
  for (const [label, pats] of SIGS) {
    try {
      const [r] = await sql`
        SELECT count(*)::bigint AS n, coalesce(sum(calls),0)::bigint AS calls
          FROM ${sql(schema)}.pg_stat_statements
         WHERE query LIKE ALL(${pats}::text[])`;
      note(`  ${label.padEnd(38)} ${String(r.n).padStart(10)} | ${r.calls}`);
      seen.push([label, Number(r.calls)]);
    } catch (e) { note(`  ${label.padEnd(38)} FAILED: ${e.message}`); }
  }

  /* Print the matched statements in full for the two that decide it, so the
     LIKE match can be checked by eye instead of trusted. */
  for (const [label, pats] of [SIGS[1], SIGS[3], SIGS[6], SIGS[7]]) {
    note(`\n--- full text of matches for: ${label} ---`);
    try {
      const rows = await sql`
        SELECT calls, length(query) AS len, regexp_replace(query, '\\s+', ' ', 'g') AS q
          FROM ${sql(schema)}.pg_stat_statements
         WHERE query LIKE ALL(${pats}::text[])
         ORDER BY calls DESC LIMIT 3`;
      if (!rows.length) note(`    (no statement matched — this read has NEVER executed in this window)`);
      for (const r of rows) {
        note(`    calls=${r.calls} len=${r.len}`);
        note(`      ${String(r.q).slice(0, 900)}`);
      }
    } catch (e) { note(`    FAILED: ${e.message}`); }
  }

  /* ── What un-truncating the demand read would actually put on the page ───
     The proposed fix takes the plan from a slice to all 13,920 matching rows.
     Those rows are only real demand if the delivered-netting removes the ones
     already fulfilled (routes/mrp.ts:513, effQtyOf > 0). The status histogram
     says almost every SO in this database is still CONFIRMED, so this is the
     number that decides whether the fix restores a plan or invents one. */
  const CO = Number(process.env.COMPANY || 1);
  const SO_DONE = ['SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'];
  note(`\n--- what the un-truncated demand set looks like after delivered-netting (company ${CO}) ---`);
  try {
    const [r] = await sql`
      WITH d AS (
        SELECT i.id, i.qty,
               coalesce(sum(dl.qty) FILTER (
                 WHERE upper(d2.status::text) NOT IN ('CANCELLED','DRAFT')), 0) AS delivered
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
          LEFT JOIN scm.delivery_order_items dl ON dl.so_item_id = i.id
          LEFT JOIN scm.delivery_orders d2 ON d2.id = dl.delivery_order_id
         WHERE i.company_id = ${CO}::bigint AND i.cancelled = false
           AND NOT (s.status::text = ANY(${SO_DONE}::text[]))
         GROUP BY i.id, i.qty)
      SELECT count(*)::bigint AS matching,
             count(*) FILTER (WHERE qty - delivered > 0)::bigint AS still_demanding,
             sum(greatest(qty - delivered, 0))::bigint AS units
        FROM d`;
    note(`  rows matching the filters            ${r.matching}`);
    note(`  STILL demanding after netting        ${r.still_demanding}`);
    note(`  units of demand those rows carry     ${r.units}`);
    note(`  (today the page plans over at most the first ~1000 of them, in uuid order)`);
  } catch (e) { note(`  FAILED: ${e.message}`); }

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
