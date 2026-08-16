#!/usr/bin/env node
/* How much of the plan is standing on the EMPTY-VARIANT PO fallback. READ-ONLY.
 *
 * routes/mrp.ts:831-836 (general) and :988-994 (sofa) fold the same-warehouse
 * EMPTY-variant ('') purchase-order pool into a SPECIFIC-variant demand bucket
 * whenever that bucket has no PO supply of its own:
 *
 *     const legacyKey = composite(whId, code, '');
 *     const ownPo     = poByKey.get(k) ?? [];
 *     const useLegacy = bucket.vkey !== '' && legacyKey !== k && ownPo.length === 0;
 *
 * The owner ruled (2026-08-16) that a different variant is a DIFFERENT THING and
 * cannot satisfy the order. Under that rule this fallback lets a PO for an
 * unspecified bedframe cover demand for a specific fabric/gap/divan/leg/height
 * and hides a real shortage. This probe measures what that is worth today.
 *
 * NOTHING IS RE-DERIVED. The bucket key comes from the app's own
 * computeVariantKey + composite, and the line->warehouse rule from the app's own
 * resolveLineWarehouseId, so a bucket here is the same bucket the page draws.
 * Run under tsx so those TS modules import for real:
 *
 *     npx tsx scripts/probe-mrp-legacy-variant-fallback.mjs
 *
 * WHY BUCKET ARITHMETIC IS EXACT AND NOT AN APPROXIMATION. MRP's greedy walk
 * drains two pools (stock, then the PO queue) line by line, so the bucket's
 * TOTAL shortage is order-independent: max(0, need - stock - poSupply). The page
 * runs includeUndated=false (routes/mrp.ts:1278) and undated lines sort LAST
 * (byDateAsc puts nulls after every date), so undated demand can only ever
 * consume what the dated lines left behind -> the visible shortage is exactly
 * max(0, DATED need - stock - poSupply). And applyCommittedSupply
 * (lib/ship-commitment.ts:350) moves units from the PO pool into stockAddBack in
 * the SAME bucketKey, so (stock + poSupply) is unchanged by commitments; it also
 * drops zero-qty entries, which makes MRP's `ownPo.length === 0` test identical
 * to ownPoQty === 0.
 *
 * Env: DATABASE_URL (required), COMPANY (default 1), VERBOSE=1 for per-bucket rows.
 */
import postgres from "postgres";
import { computeVariantKey } from "../src/scm/shared/variant-key.ts";
import { composite, WH_NONE } from "../src/scm/lib/committed-shipments.ts";
import { resolveLineWarehouseId } from "../src/scm/lib/so-warehouse.ts";
import { isServiceLine } from "../src/scm/shared/service-sku.ts";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const VERBOSE = process.env.VERBOSE === "1";

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* routes/mrp.ts:118 — the ONLY two statuses MRP treats as dead PO supply.
   Not the CANCELLED/CLOSED/DRAFT triple some older probes used: a CLOSED PO
   still counts as supply here, and getting that wrong changes every number. */
const PO_DEAD = new Set(["CANCELLED", "DRAFT"]);

/* routes/mrp.ts:769 catFromGroup — the fallback category for an SO line whose
   item_code is not in mfg_products yet. */
const catFromGroup = (g) => {
  const s = (g ?? "").trim().toUpperCase();
  if (s.includes("BEDFRAME")) return "BEDFRAME";
  if (s.includes("SOFA")) return "SOFA";
  if (s.includes("MATTRESS")) return "MATTRESS";
  if (s.includes("ACCESSOR")) return "ACCESSORY";
  if (s.includes("SERVICE")) return "SERVICE";
  return null;
};

const n = (v) => Number(v ?? 0);
const pad = (v, w) => String(v).padStart(w);

async function main() {
  note(`\n${"=".repeat(78)}`);
  note(`MRP empty-variant ('') PO fallback — exposure report, company ${CO}`);
  note(`SO terminal states: ${SO_TERMINAL_STATES.join(",")}   PO dead: ${[...PO_DEAD].join(",")}`);
  note("=".repeat(78));

  // ── masters ────────────────────────────────────────────────────────────────
  const whRows = await sql`
    SELECT id::text AS id, code, name
      FROM scm.warehouses
     WHERE company_id = ${CO}::bigint AND is_active = true`;
  const stateMaps = await sql`
    SELECT state, warehouse_id::text AS warehouse_id
      FROM scm.state_warehouse_mappings
     WHERE company_id = ${CO}::bigint`;
  const masters = { warehouses: whRows, stateMappings: stateMaps };
  const whName = new Map(whRows.map((w) => [w.id, w.code || w.name]));

  const prods = await sql`
    SELECT code, category FROM scm.mfg_products WHERE company_id = ${CO}::bigint`;
  const catByCode = new Map(prods.map((p) => [p.code, p.category]));

  // ── demand: MRP's own lens (routes/mrp.ts:466 + the demandActive filter) ────
  const demandRaw = await sql`
    SELECT i.id::text                        AS id,
           i.doc_no,
           i.item_code,
           i.item_group,
           i.variants                        AS variants,
           i.qty                             AS qty,
           i.warehouse_id::text              AS warehouse_id,
           i.line_delivery_date::text        AS line_delivery_date,
           s.status::text                    AS so_status,
           s.customer_delivery_date::text    AS so_delivery_date,
           s.customer_state                  AS customer_state,
           s.sales_location                  AS sales_location
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s
        ON s.doc_no = i.doc_no AND s.company_id = i.company_id
     WHERE i.company_id = ${CO}::bigint
       AND i.cancelled = false
       AND i.qty > 0
       AND upper(coalesce(s.status::text,'')) <> ALL (${SO_TERMINAL_STATES})
     ORDER BY i.id`;

  /* delivered net of returns per SO line — soDeliverableRemaining's own rule
     (routes/delivery-orders-mfg.ts:2248-2300): active DO lines only (parent NOT
     CANCELLED and NOT DRAFT), returns traced through those same DO lines with a
     non-CANCELLED parent DR. */
  const delivered = await sql`
    SELECT di.so_item_id::text AS so_item_id, sum(di.qty)::numeric AS qty
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL
       AND upper(coalesce(d.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     GROUP BY 1`;
  const returned = await sql`
    SELECT di.so_item_id::text AS so_item_id, sum(ri.qty_returned)::numeric AS qty
      FROM scm.delivery_return_items ri
      JOIN scm.delivery_returns r  ON r.id = ri.delivery_return_id
      JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
      JOIN scm.delivery_orders d   ON d.id = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL
       AND upper(coalesce(r.status::text,'')) <> 'CANCELLED'
       AND upper(coalesce(d.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     GROUP BY 1`;
  const delMap = new Map(delivered.map((r) => [r.so_item_id, n(r.qty)]));
  const retMap = new Map(returned.map((r) => [r.so_item_id, n(r.qty)]));

  // ── buckets: exactly MRP's sections 6 and 8 ────────────────────────────────
  const buckets = new Map(); // composite key -> bucket
  let skippedService = 0;
  for (const d of demandRaw) {
    const cat = catByCode.get(d.item_code) ?? catFromGroup(d.item_group);
    if (isServiceLine({ itemGroup: d.item_group, itemCode: d.item_code, category: cat })) {
      skippedService += 1;
      continue;
    }
    const eff = Math.max(0, n(d.qty) - Math.max(0, (delMap.get(d.id) ?? 0) - (retMap.get(d.id) ?? 0)));
    if (eff <= 0) continue;
    const whId = resolveLineWarehouseId(
      d.warehouse_id,
      { sales_location: d.sales_location, customer_state: d.customer_state },
      masters,
    );
    const vkey = computeVariantKey(d.item_group, d.variants ?? null);
    const k = composite(whId, d.item_code, vkey);
    const dated = Boolean(d.line_delivery_date ?? d.so_delivery_date);
    const b = buckets.get(k) ?? {
      k, whId, code: d.item_code, vkey, cat,
      path: cat === "SOFA" ? "sofa(§8)" : "general(§7)",
      needDated: 0, needAll: 0, lines: 0, linesDated: 0, docs: new Set(),
    };
    b.needAll += eff;
    b.lines += 1;
    if (dated) { b.needDated += eff; b.linesDated += 1; b.docs.add(d.doc_no); }
    buckets.set(k, b);
  }

  // ── stock ──────────────────────────────────────────────────────────────────
  const bal = await sql`
    SELECT product_code, warehouse_id::text AS warehouse_id,
           coalesce(variant_key,'') AS variant_key, qty::numeric AS qty
      FROM scm.inventory_balances
     WHERE company_id = ${CO}::bigint`;
  const stockByKey = new Map();
  for (const b of bal) {
    const k = composite(b.warehouse_id ?? null, b.product_code, b.variant_key ?? "");
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + n(b.qty));
  }

  // ── open PO supply ─────────────────────────────────────────────────────────
  const poRaw = await sql`
    SELECT p.po_number, p.status, p.purchase_location_id::text AS purchase_location_id,
           i.material_code, i.item_group, i.variants AS variants,
           i.qty::numeric AS qty, coalesce(i.received_qty,0)::numeric AS received_qty,
           i.warehouse_id::text AS warehouse_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE i.company_id = ${CO}::bigint
     ORDER BY i.id`;
  const poQtyByKey = new Map();
  const poLinesByKey = new Map();
  let openPoLines = 0, openPoUnits = 0, emptyKeyPoLines = 0, emptyKeyPoUnits = 0;
  for (const r of poRaw) {
    if (PO_DEAD.has(String(r.status ?? "").toUpperCase())) continue;
    const left = n(r.qty) - n(r.received_qty);
    if (left <= 0) continue;
    const poWh = r.warehouse_id ?? r.purchase_location_id ?? null;
    const vkey = computeVariantKey(r.item_group, r.variants ?? null);
    const k = composite(poWh, r.material_code, vkey);
    openPoLines += 1; openPoUnits += left;
    if (vkey === "") { emptyKeyPoLines += 1; emptyKeyPoUnits += left; }
    poQtyByKey.set(k, (poQtyByKey.get(k) ?? 0) + left);
    const arr = poLinesByKey.get(k) ?? [];
    arr.push(`${r.po_number}(${r.status},${left})`);
    poLinesByKey.set(k, arr);
  }

  // ── SECTION A — the size of the '' pool ────────────────────────────────────
  note(`\n--- A. the empty-variant ('') PO pool ---`);
  note(`  open PO lines (status not ${[...PO_DEAD].join("/")}, qty>received): ${openPoLines}  units left ${openPoUnits}`);
  note(`  ...of which key '' :                                              ${emptyKeyPoLines}  units left ${emptyKeyPoUnits}`);
  const emptyPoKeys = [...poQtyByKey.keys()].filter((k) => k.endsWith("|"));
  note(`  distinct (warehouse, code) groups holding an open '' pool:        ${emptyPoKeys.length}`);

  // ── SECTION B/C — who the fallback feeds, and the shortage delta ───────────
  const rows = [];
  for (const b of buckets.values()) {
    const legacyKey = composite(b.whId, b.code, "");
    const ownPo = poQtyByKey.get(b.k) ?? 0;
    const legacyPo = poQtyByKey.get(legacyKey) ?? 0;
    // MRP's exact predicate. ownPo.length===0 <=> ownPo qty 0 (see header).
    const useLegacy = b.vkey !== "" && legacyKey !== b.k && ownPo === 0;
    const stock = stockByKey.get(b.k) ?? 0;
    const now = Math.max(0, b.needDated - stock - ownPo - (useLegacy ? legacyPo : 0));
    const strict = Math.max(0, b.needDated - stock - ownPo);
    rows.push({ ...b, legacyKey, ownPo, legacyPo, useLegacy, stock, now, strict });
  }

  const fed = rows.filter((r) => r.useLegacy && r.legacyPo > 0);
  const changed = fed.filter((r) => r.strict > r.now);
  const flipped = changed.filter((r) => r.now === 0);          // covered -> SHORT
  const worsened = changed.filter((r) => r.now > 0);           // short -> shorter
  const extraUnits = changed.reduce((a, r) => a + (r.strict - r.now), 0);

  note(`\n--- B. buckets the fallback is actually feeding ---`);
  note(`  total demand buckets (all categories, dated+undated):          ${buckets.size}`);
  note(`  specific-variant buckets eligible (vkey<>'' and no own PO):    ${rows.filter((r) => r.useLegacy).length}`);
  note(`  ...that actually draw a NON-EMPTY '' pool:                     ${fed.length}`);
  note(`     general (§7) ${fed.filter((r) => r.path.startsWith("general")).length}   sofa (§8) ${fed.filter((r) => r.path.startsWith("sofa")).length}`);
  note(`  dated SO lines sitting in those buckets:                       ${fed.reduce((a, r) => a + r.linesDated, 0)}`);
  note(`  dated units sitting in those buckets:                          ${fed.reduce((a, r) => a + r.needDated, 0)}`);
  note(`  SKIPPED as SERVICE lines (never demand):                       ${skippedService}`);

  note(`\n--- C. what REMOVING the fallback does to the page today ---`);
  note(`  page runs includeUndated=false and onlyShort defaults FALSE, so no row`);
  note(`  APPEARS or disappears: a demand bucket is already a row. What changes is`);
  note(`  how many rows are ORANGE (shortage>0) and what PO Outstanding reads.`);
  note(`  rows flipping covered -> SHORTAGE:                             ${flipped.length}`);
  note(`  rows already short that get shorter:                           ${worsened.length}`);
  note(`  extra shortage UNITS revealed:                                 ${extraUnits}`);
  note(`  PO Outstanding currently inflated on these rows by:            ${fed.reduce((a, r) => a + r.legacyPo, 0)} units (mrp.ts:903)`);

  if (flipped.length || worsened.length || VERBOSE) {
    note(`\n  bucket                                                     need  stock ownPO legPO  now->strict`);
    for (const r of (VERBOSE ? fed : changed).sort((a, b) => (b.strict - b.now) - (a.strict - a.now))) {
      const label = `${(whName.get(r.whId) ?? r.whId ?? WH_NONE)}|${r.code}|${r.vkey}`;
      note(`  ${label.slice(0, 56).padEnd(56)} ${pad(r.needDated, 5)} ${pad(r.stock, 6)} ${pad(r.ownPo, 5)} ${pad(r.legacyPo, 5)}  ${r.now}->${r.strict}   ${r.path}  ${[...r.docs].slice(0, 4).join(",")}`);
      note(`      '' pool lines: ${(poLinesByKey.get(r.legacyKey) ?? []).join(" ")}`);
    }
  }

  // ── SECTION D — one '' pool feeding MORE THAN ONE bucket (N-fold count) ────
  const drawersByLegacy = new Map();
  for (const r of fed) {
    const arr = drawersByLegacy.get(r.legacyKey) ?? [];
    arr.push(r);
    drawersByLegacy.set(r.legacyKey, arr);
  }
  const multi = [...drawersByLegacy.entries()].filter(([, arr]) => arr.length > 1);
  note(`\n--- D. ONE '' pool folded into MORE THAN ONE variant bucket ---`);
  note(`  Each eligible bucket clones the pool independently (mrp.ts:834-836 /`);
  note(`  :991-993 '.map(p => ({...p}))'), so N buckets each get the FULL qty.`);
  note(`  '' pools drawn by 2+ buckets:                                  ${multi.length}`);
  let overcount = 0;
  for (const [lk, arr] of multi) {
    const pool = poQtyByKey.get(lk) ?? 0;
    const drawn = arr.reduce((a, r) => a + Math.min(pool, Math.max(0, r.needDated - r.stock)), 0);
    const over = Math.max(0, drawn - pool);
    overcount += over;
    note(`   ${lk}  pool=${pool}  buckets=${arr.length}  claimed=${drawn}  OVER=${over}`);
    for (const r of arr) note(`      -> ${r.vkey || "(empty)"}  needDated=${r.needDated} stock=${r.stock}`);
  }
  note(`  units the same '' PO is promised to more than one bucket:      ${overcount}`);

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* closed */ }
  process.exit(1);
});
