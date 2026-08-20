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
 * and mrp.ts:902-903 adds that same pool to the row's displayed PO Outstanding.
 *
 * The owner ruled (2026-08-16) that a different variant is a DIFFERENT THING and
 * cannot satisfy the order. Under that rule this fallback lets a PO for an
 * unspecified bedframe cover demand for a specific fabric/gap/divan/leg/height
 * and hide a real shortage. This probe measures what that is worth today.
 *
 * IT ANSWERS THE QUESTION audit-mrp-pairing.mjs SECTION (D) DOES NOT. That audit
 * counts only the (warehouse,item) groups where MORE THAN ONE variant bucket
 * draws one legacy pool (the N-fold clone). A group where exactly ONE bucket
 * draws is not double-counting and is not printed there — but under the owner's
 * rule it is still a wrong-variant cover, and it is the common case.
 *
 * NOTHING IS RE-DERIVED. The bucket key comes from the app's own
 * computeVariantKey + composite, the line->warehouse rule from its own
 * resolveLineWarehouseId, and the SERVICE test from its own isServiceLine, so a
 * bucket here is the bucket the page draws. Run under tsx so those TS modules
 * import for real:
 *
 *     npx tsx scripts/probe-mrp-legacy-variant-fallback.mjs
 *
 * WHY BUCKET ARITHMETIC IS EXACT AND NOT AN APPROXIMATION. MRP's greedy walk
 * drains two pools (stock, then the PO queue) line by line, so a bucket's TOTAL
 * shortage is order-independent: max(0, need - stock - poSupply). Undated lines
 * sort LAST (byDateAsc puts nulls after every date), so undated demand can only
 * consume what the dated lines left behind -> the DATED shortage is exactly
 * max(0, DATED need - stock - poSupply), and that holds whichever way
 * includeUndated is set (it is display-only; default SHOWN since 2026-08-18, so
 * the page's visible shortage now includes the undated rows' own shortfall). applyCommittedSupply
 * (lib/ship-commitment.ts:350-377) moves units out of the PO pool and into
 * stockAddBack under the SAME bucketKey, so (stock + poSupply) per bucket is
 * unchanged by commitments; it also drops zero-qty entries, which is what makes
 * MRP's `ownPo.length === 0` test identical to ownPoQty === 0 here.
 *
 * Env: DATABASE_URL (required). COMPANY (optional; default = every company that
 * has Sales Orders). VERBOSE=1 to print every drawing bucket, not just the ones
 * whose shortage changes.
 */
import postgres from "postgres";
import { computeVariantKey } from "../src/scm/shared/variant-key.ts";
import { composite, WH_NONE } from "../src/scm/lib/committed-shipments.ts";
import { resolveLineWarehouseId } from "../src/scm/lib/so-warehouse.ts";
import { isServiceLine } from "../src/scm/shared/service-sku.ts";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const ONLY_CO = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const VERBOSE = process.env.VERBOSE === "1";

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* mrp.ts:118 — the ONLY two statuses MRP treats as dead PO supply. NOT the
   CANCELLED/CLOSED/DRAFT triple older probes used: a CLOSED PO still counts as
   supply in this engine, and getting that wrong moves every number below. */
const PO_DEAD = new Set(["CANCELLED", "DRAFT"]);

/* mrp.ts:769 catFromGroup — the category fallback for an SO line whose
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

async function runCompany(CO) {
  note("");
  note("=".repeat(84));
  note(`COMPANY ${CO} — MRP empty-variant ('') PO fallback exposure`);
  note(`SO terminal: ${SO_TERMINAL_STATES.join(",")}    PO dead: ${[...PO_DEAD].join(",")}`);
  note("=".repeat(84));

  // ── masters (mrp.ts:559 loads ACTIVE warehouses only) ──────────────────────
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

  // ── demand — MRP's own lens (mrp.ts:466 + the demandActive filter) ─────────
  const demandRaw = await sql`
    SELECT i.id::text                        AS id,
           i.doc_no                          AS doc_no,
           i.item_code                       AS item_code,
           i.item_group                      AS item_group,
           i.variants                        AS variants,
           i.qty                             AS qty,
           i.warehouse_id::text              AS warehouse_id,
           i.line_delivery_date::text        AS line_delivery_date,
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
     (delivery-orders-mfg.ts:2248-2300): DO lines whose parent is neither
     CANCELLED nor DRAFT; returns traced back through those same DO lines with a
     non-CANCELLED parent DR. ENUM TRAP: status columns are enums, so ::text
     before coalesce (coalesce(col,'') coerces '' into the enum and throws). */
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
      JOIN scm.delivery_returns r     ON r.id  = ri.delivery_return_id
      JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
      JOIN scm.delivery_orders d      ON d.id  = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL
       AND upper(coalesce(r.status::text,'')) <> 'CANCELLED'
       AND upper(coalesce(d.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     GROUP BY 1`;
  const delMap = new Map(delivered.map((r) => [r.so_item_id, n(r.qty)]));
  const retMap = new Map(returned.map((r) => [r.so_item_id, n(r.qty)]));

  // ── buckets — MRP sections 6 (general) and 8 (sofa) ───────────────────────
  const buckets = new Map();
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
      k, whId, code: d.item_code, vkey, cat: cat ?? "(uncatalogued)",
      path: cat === "SOFA" ? "sofa(S8)" : "general(S7)",
      needDated: 0, needAll: 0, lines: 0, linesDated: 0, docs: new Set(),
    };
    b.needAll += eff;
    b.lines += 1;
    if (dated) { b.needDated += eff; b.linesDated += 1; b.docs.add(d.doc_no); }
    buckets.set(k, b);
  }

  // ── stock (mrp.ts:605-612) ────────────────────────────────────────────────
  const bal = await sql`
    SELECT item_code, warehouse_id::text AS warehouse_id,
           coalesce(variant_key,'') AS variant_key, qty::numeric AS qty
      FROM scm.inventory_balances
     WHERE company_id = ${CO}::bigint`;
  const stockByKey = new Map();
  for (const b of bal) {
    const k = composite(b.warehouse_id ?? null, b.item_code, b.variant_key ?? "");
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + n(b.qty));
  }

  // ── open PO supply (mrp.ts:621-680) ───────────────────────────────────────
  const poRaw = await sql`
    SELECT p.po_number, p.status::text AS status,
           p.purchase_location_id::text AS purchase_location_id,
           i.item_code, i.item_group, i.variants AS variants,
           i.qty::numeric AS qty, coalesce(i.received_qty,0)::numeric AS received_qty,
           i.warehouse_id::text AS warehouse_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE i.company_id = ${CO}::bigint
     ORDER BY i.id`;
  const poQtyByKey = new Map();
  const poLinesByKey = new Map();
  const emptyPoMeta = new Map(); // legacyKey -> {units, cats:Set, variantBearing:number}
  let openPoLines = 0, openPoUnits = 0, emptyKeyPoLines = 0, emptyKeyPoUnits = 0;
  /* An empty key is only SUSPICIOUS for a variant-BEARING category. MATTRESS and
     ACCESSORY have no attributes in ATTRS_BY_GROUP (variant-key.ts:74-80), so
     their key is '' BY DESIGN — for them the demand bucket is also '', which
     makes legacyKey === k and the fallback provably unreachable. Only BEDFRAME
     and SOFA can produce a genuinely "unspecified variant" PO. */
  const VARIANT_BEARING = new Set(["BEDFRAME", "SOFA"]);
  let emptyKeyVariantBearingLines = 0, emptyKeyVariantBearingUnits = 0;
  for (const r of poRaw) {
    if (PO_DEAD.has(String(r.status ?? "").toUpperCase())) continue;
    const left = n(r.qty) - n(r.received_qty);
    if (left <= 0) continue;
    const poWh = r.warehouse_id ?? r.purchase_location_id ?? null;
    const vkey = computeVariantKey(r.item_group, r.variants ?? null);
    const k = composite(poWh, r.item_code, vkey);
    openPoLines += 1; openPoUnits += left;
    const poCat = catByCode.get(r.item_code) ?? catFromGroup(r.item_group);
    if (vkey === "") {
      emptyKeyPoLines += 1; emptyKeyPoUnits += left;
      const m = emptyPoMeta.get(k) ?? { whId: poWh, code: r.item_code, units: 0, cats: new Set(), variantBearing: 0 };
      m.units += left;
      m.cats.add(poCat ?? "(uncatalogued)");
      if (VARIANT_BEARING.has(poCat ?? "")) {
        m.variantBearing += left;
        emptyKeyVariantBearingLines += 1; emptyKeyVariantBearingUnits += left;
      }
      emptyPoMeta.set(k, m);
    }
    poQtyByKey.set(k, (poQtyByKey.get(k) ?? 0) + left);
    const arr = poLinesByKey.get(k) ?? [];
    arr.push(`${r.po_number}[${r.status},left ${left}]`);
    poLinesByKey.set(k, arr);
  }

  // ── A. the size of the '' pool ────────────────────────────────────────────
  note("");
  note("--- A. the empty-variant ('') open PO pool ---");
  note(`  open PO lines (alive status, qty>received) : ${openPoLines}   units left ${openPoUnits}`);
  note(`  ...whose MRP variant key is ''            : ${emptyKeyPoLines}   units left ${emptyKeyPoUnits}`);
  note(`  ...of THOSE, in a variant-BEARING category (BEDFRAME/SOFA) — the only`);
  note(`     ones whose '' can mean "variant unspecified" rather than "no variants`);
  note(`     exist for this category" : ${emptyKeyVariantBearingLines} lines, ${emptyKeyVariantBearingUnits} units`);
  const emptyPoKeys = [...poQtyByKey.keys()].filter((k) => k.endsWith("|"));
  note(`  distinct (warehouse|code) '' pools open    : ${emptyPoKeys.length}`);

  // ── B/C. who draws it, and the shortage delta ─────────────────────────────
  const rows = [];
  for (const b of buckets.values()) {
    const legacyKey = composite(b.whId, b.code, "");
    const ownPo = poQtyByKey.get(b.k) ?? 0;
    const legacyPo = poQtyByKey.get(legacyKey) ?? 0;
    const useLegacy = b.vkey !== "" && legacyKey !== b.k && ownPo === 0;
    const stock = stockByKey.get(b.k) ?? 0;
    const now = Math.max(0, b.needDated - stock - ownPo - (useLegacy ? legacyPo : 0));
    const strict = Math.max(0, b.needDated - stock - ownPo);
    rows.push({ ...b, legacyKey, ownPo, legacyPo, useLegacy, stock, now, strict });
  }
  const eligible = rows.filter((r) => r.useLegacy);
  const fed = eligible.filter((r) => r.legacyPo > 0);
  const changed = fed.filter((r) => r.strict > r.now);
  const flipped = changed.filter((r) => r.now === 0);
  const worsened = changed.filter((r) => r.now > 0);
  const extraUnits = changed.reduce((a, r) => a + (r.strict - r.now), 0);
  const byCat = new Map();
  for (const r of fed) byCat.set(r.cat, (byCat.get(r.cat) ?? 0) + 1);

  note("");
  note("--- B. buckets the fallback is actually feeding ---");
  note(`  demand buckets in total                              : ${buckets.size}`);
  note(`  eligible (vkey<>'' and no PO of their own)            : ${eligible.length}`);
  note(`  ...that DRAW a non-empty '' pool  <-- THE ANSWER      : ${fed.length}`);
  note(`      by path     : general(S7) ${fed.filter((r) => r.path[0] === "g").length}   sofa(S8) ${fed.filter((r) => r.path[0] === "s").length}`);
  note(`      by category : ${[...byCat].map(([c, v]) => `${c} ${v}`).join("   ") || "(none)"}`);
  note(`  dated SO lines inside those buckets                  : ${fed.reduce((a, r) => a + r.linesDated, 0)}`);
  note(`  dated units inside those buckets                     : ${fed.reduce((a, r) => a + r.needDated, 0)}`);
  note(`  SO lines skipped as SERVICE (never demand)           : ${skippedService}`);

  note("");
  note("--- C. what REMOVING the fallback changes on the page TODAY ---");
  note("  Mrp.tsx:420 onlyShort defaults FALSE and a demand bucket is already a row,");
  note("  so NO row appears or disappears. What changes is which rows are ORANGE");
  note("  (shortage>0), the shortage totals, and the PO Outstanding column.");
  note(`  rows flipping COVERED -> SHORTAGE            : ${flipped.length}`);
  note(`  rows already short that get shorter          : ${worsened.length}`);
  note(`  extra shortage UNITS revealed                : ${extraUnits}`);
  note(`  PO Outstanding shown on these rows today from the '' pool (mrp.ts:903) : ${fed.reduce((a, r) => a + r.legacyPo, 0)} units`);

  const show = VERBOSE ? fed : changed;
  if (show.length) {
    note("");
    note(`  ${"bucket (warehouse|code|variant_key)".padEnd(58)}  need  stock ownPO legPO  now->strict`);
    for (const r of show.sort((a, b) => (b.strict - b.now) - (a.strict - a.now))) {
      const label = `${whName.get(r.whId) ?? r.whId ?? WH_NONE}|${r.code}|${r.vkey}`;
      note(`  ${label.slice(0, 58).padEnd(58)} ${pad(r.needDated, 5)} ${pad(r.stock, 6)} ${pad(r.ownPo, 5)} ${pad(r.legacyPo, 5)}  ${r.now}->${r.strict}  ${r.path} ${r.cat}`);
      note(`      SOs: ${[...r.docs].slice(0, 6).join(" ")}`);
      note(`      '' pool: ${(poLinesByKey.get(r.legacyKey) ?? []).join(" ")}`);
    }
  }

  // ── D. one '' pool folded into more than one bucket (N-fold clone) ────────
  const drawersByLegacy = new Map();
  for (const r of fed) {
    const arr = drawersByLegacy.get(r.legacyKey) ?? [];
    arr.push(r); drawersByLegacy.set(r.legacyKey, arr);
  }
  const multi = [...drawersByLegacy.entries()].filter(([, arr]) => arr.length > 1);
  note("");
  note("--- D. ONE '' pool cloned into MORE THAN ONE variant bucket ---");
  note("  Each eligible bucket clones the pool (mrp.ts:836 / :994 '.map(p => ({...p}))'),");
  note("  so N buckets each receive the FULL open quantity. This is the number");
  note("  audit-mrp-pairing.mjs section (D) reports; it is a SUBSET of B above.");
  note(`  '' pools drawn by 2+ buckets : ${multi.length}`);
  let overcount = 0;
  for (const [lk, arr] of multi) {
    const pool = poQtyByKey.get(lk) ?? 0;
    const drawn = arr.reduce((a, r) => a + Math.min(pool, Math.max(0, r.needDated - r.stock)), 0);
    const over = Math.max(0, drawn - pool);
    overcount += over;
    note(`   ${lk}  pool=${pool} buckets=${arr.length} claimed=${drawn} OVER=${over}`);
    for (const r of arr) note(`      -> vkey=${r.vkey || "''"}  needDated=${r.needDated} stock=${r.stock}`);
  }
  note(`  units the same '' PO is promised to more than one bucket : ${overcount}`);

  /* ── E. EXIT-ZERO IS NOT SUCCESS ──────────────────────────────────────────
     A zero in B is only believable if every open '' pool is ACCOUNTED FOR. This
     classifies all of them, so a zero produced by a broken key (warehouses that
     never line up, a demand read that returned nothing) cannot pass as "the
     fallback is unused". The buckets are counted straight out of the same maps
     B used — no second derivation. */
  const bucketsByWhCode = new Map();
  for (const r of rows) {
    const gk = `${r.whId ?? WH_NONE}|${r.code}`;
    const arr = bucketsByWhCode.get(gk) ?? [];
    arr.push(r); bucketsByWhCode.set(gk, arr);
  }
  const codeHasVariantDemandAnywhere = new Map(); // code -> [wh...]
  for (const r of rows) {
    if (r.vkey === "") continue;
    const arr = codeHasVariantDemandAnywhere.get(r.code) ?? [];
    arr.push(r.whId ?? WH_NONE); codeHasVariantDemandAnywhere.set(r.code, arr);
  }
  const cls = { noDemand: 0, onlyEmptyDemand: 0, variantButOwnPo: 0, drew: 0 };
  const wrongWarehouse = [];
  for (const [lk, meta] of emptyPoMeta) {
    /* whId/code carried from the PO row itself — NEVER re-parsed out of the
       composite string, so an item code containing the separator cannot
       silently mis-bin a pool and manufacture a zero. */
    const group = bucketsByWhCode.get(`${meta.whId ?? WH_NONE}|${meta.code}`) ?? [];
    const variantBuckets = group.filter((r) => r.vkey !== "");
    if (group.length === 0) {
      cls.noDemand += 1;
      const elsewhere = codeHasVariantDemandAnywhere.get(meta.code);
      if (elsewhere) wrongWarehouse.push({ lk, units: poQtyByKey.get(lk) ?? 0, elsewhere: [...new Set(elsewhere)] });
    } else if (variantBuckets.length === 0) cls.onlyEmptyDemand += 1;
    else if (variantBuckets.every((r) => r.ownPo > 0)) cls.variantButOwnPo += 1;
    else cls.drew += 1;
  }
  note("");
  note("--- E. every open '' pool accounted for (a zero in B must be explained) ---");
  note(`  '' pools with NO live demand at all in that warehouse+code : ${cls.noDemand}`);
  note(`  '' pools whose only demand ALSO keys '' (legacyKey === k,`);
  note(`     fallback provably unreachable — mattress/accessory)     : ${cls.onlyEmptyDemand}`);
  note(`  '' pools whose variant buckets ALL have their own PO       : ${cls.variantButOwnPo}`);
  note(`  '' pools that DID feed a variant bucket (must equal B)     : ${cls.drew}`);
  note(`  ---- sum must equal the ${emptyPoMeta.size} open '' pools: ${cls.noDemand + cls.onlyEmptyDemand + cls.variantButOwnPo + cls.drew}`);
  note(`  NEAR MISSES — '' pool with no demand in ITS warehouse, but the same code`);
  note(`  HAS specific-variant demand in another warehouse (one warehouse edit away`);
  note(`  from becoming a wrong-variant cover): ${wrongWarehouse.length}`);
  for (const w of wrongWarehouse.slice(0, 15)) {
    note(`      ${w.lk}  units=${w.units}  variant demand sits in: ${w.elsewhere.join(",")}`);
  }

  return {
    fed: fed.length, flipped: flipped.length, worsened: worsened.length, extraUnits,
    multi: multi.length, emptyVB: emptyKeyVariantBearingUnits, nearMiss: wrongWarehouse.length,
  };
}

async function main() {
  const companies = ONLY_CO != null
    ? [ONLY_CO]
    : (await sql`SELECT DISTINCT company_id FROM scm.mfg_sales_orders WHERE company_id IS NOT NULL ORDER BY company_id`)
        .map((r) => Number(r.company_id));
  note(`companies with Sales Orders: ${JSON.stringify(companies)}`);
  const totals = [];
  for (const co of companies) totals.push([co, await runCompany(co)]);
  note("");
  note("======== ROLL-UP ========");
  for (const [co, t] of totals) {
    note(`  company ${co}: buckets drawing the '' pool ${t.fed} | covered->short ${t.flipped} | shorter ${t.worsened} | extra shortage units ${t.extraUnits} | pools cloned 2+ ${t.multi} | bedframe/sofa '' PO units open ${t.emptyVB} | near-miss pools ${t.nearMiss}`);
  }
  note("  READ-ONLY — SELECTs only, no DDL, no writes, no transaction.");
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* closed */ }
  process.exit(1);
});
