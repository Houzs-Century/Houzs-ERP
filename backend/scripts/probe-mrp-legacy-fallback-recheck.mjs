#!/usr/bin/env node
/* INDEPENDENT RE-CHECK of the "MRP empty-variant ('') PO fallback is dormant"
 * claim. READ-ONLY — SELECTs only.
 *
 * The claim under test (routes/mrp.ts:831-837, :902-903, :988-994):
 *
 *     const legacyKey = composite(whId, code, '');
 *     const ownPo     = poByKey.get(k) ?? [];
 *     const useLegacy = bucket.vkey !== '' && legacyKey !== k && ownPo.length === 0;
 *
 * ...covers ZERO rows in production today, and is reachable ONLY for BEDFRAME
 * and SOFA because every other category keys '' by design.
 *
 * THREE THINGS THE EARLIER PROBE DID NOT DO, and this one does:
 *
 *  1. MRP's `ownPo` is `poByKey`, which is built from applyCommittedSupply's
 *     OUTPUT — fully-committed entries are DROPPED (lib/ship-commitment.ts:369).
 *     So a bucket whose only open PO is entirely owed to a ship-before-arrival
 *     has ownPo.length === 0 in MRP and DRAWS the fallback, while a probe that
 *     tests the RAW open quantity sees ownPo > 0 and never counts it. This runs
 *     the app's OWN outstandingCommitments + applyCommittedSupply so the
 *     predicate is byte-identical to the route's, and prints BOTH predicates so
 *     the gap between them is a number, not an assumption.
 *
 *  2. variant-key.ts:132-133 appends `special=...` for EVERY group, outside the
 *     ATTRS_BY_GROUP table. So a MATTRESS / ACCESSORY / OTHERS line carrying a
 *     special add-on keys NON-EMPTY — and mfg-pricing.ts:401-405 says special
 *     add-ons target MATTRESS on purpose (migration 0134). "Only BEDFRAME and
 *     SOFA can reach the fallback" is therefore false. This measures the size of
 *     that route.
 *
 *  3. The PO side of the trap, sized: open PO lines whose computed key is ''
 *     while their variants jsonb CARRIES real identity attributes (an
 *     unrecognised / null item_group makes ATTRS_BY_GROUP[group] ?? [] empty).
 *     Those are already-mis-keyed lines sitting in the '' pool.
 *
 * Nothing is re-derived: computeVariantKey, composite, resolveLineWarehouseId,
 * isServiceLine, outstandingCommitments and applyCommittedSupply are imported
 * from src. Run under tsx.
 *
 * Env: DATABASE_URL (required). COMPANY optional.
 */
import postgres from "postgres";
import { computeVariantKey } from "../src/scm/shared/variant-key.ts";
import { composite, WH_NONE } from "../src/scm/lib/committed-shipments.ts";
import { resolveLineWarehouseId } from "../src/scm/lib/so-warehouse.ts";
import { isServiceLine } from "../src/scm/shared/service-sku.ts";
import { outstandingCommitments, applyCommittedSupply } from "../src/scm/lib/ship-commitment.ts";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const ONLY_CO = process.env.COMPANY ? Number(process.env.COMPANY) : null;

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* mrp.ts:118 — the ONLY two statuses MRP treats as dead PO supply. */
const PO_DEAD = new Set(["CANCELLED", "DRAFT"]);
/* mrp.ts:767-775 */
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

/* Every attribute name computeVariantKey can read (variant-key.ts:35-69). If a
   line carries one of these with a value but keys '', the key LOST it. */
const IDENTITY_FIELDS = [
  "fabricCode", "colorCode", "colourCode", "fabricColor",
  "seatHeight", "depth", "gap", "divanHeight", "legHeight", "sofaLegHeight",
  "totalHeight",
];
const carriesIdentity = (v) => {
  const o = v ?? {};
  for (const f of IDENTITY_FIELDS) {
    const x = o[f];
    if (x != null && String(x).trim() !== "") return f;
  }
  if (Array.isArray(o.specials) && o.specials.length > 0) return "specials";
  return null;
};
/* A key made ONLY of specials — the route that exists for categories with no
   ATTRS_BY_GROUP entry (mattress / accessory / others / service). */
const specialsOnlyKey = (k) => k !== "" && k.split("|").every((p) => p.startsWith("special="));

async function runCompany(CO) {
  note("");
  note("=".repeat(88));
  note(`COMPANY ${CO} — independent re-check of the '' PO fallback`);
  note("=".repeat(88));

  const whRows = await sql`
    SELECT id::text AS id, code, name FROM scm.warehouses
     WHERE company_id = ${CO}::bigint AND is_active = true`;
  const stateMaps = await sql`
    SELECT state, warehouse_id::text AS warehouse_id FROM scm.state_warehouse_mappings
     WHERE company_id = ${CO}::bigint`;
  const masters = { warehouses: whRows, stateMappings: stateMaps };
  const whName = new Map(whRows.map((w) => [w.id, w.code || w.name]));

  const prods = await sql`SELECT code, category FROM scm.mfg_products WHERE company_id = ${CO}::bigint`;
  const catByCode = new Map(prods.map((p) => [p.code, p.category]));

  // ── demand (mrp.ts:466-513) ───────────────────────────────────────────────
  const demandRaw = await sql`
    SELECT i.id::text AS id, i.doc_no, i.item_code, i.item_group, i.variants,
           i.qty::numeric AS qty, i.warehouse_id::text AS warehouse_id,
           i.line_delivery_date::text AS line_delivery_date,
           s.customer_delivery_date::text AS so_delivery_date,
           s.customer_state, s.sales_location
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
     WHERE i.company_id = ${CO}::bigint AND i.cancelled = false AND i.qty > 0
       AND upper(coalesce(s.status::text,'')) <> ALL (${SO_TERMINAL_STATES})
     ORDER BY i.id`;
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
      JOIN scm.delivery_returns r      ON r.id  = ri.delivery_return_id
      JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
      JOIN scm.delivery_orders d       ON d.id  = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL
       AND upper(coalesce(r.status::text,'')) <> 'CANCELLED'
       AND upper(coalesce(d.status::text,'')) NOT IN ('CANCELLED','DRAFT')
     GROUP BY 1`;
  const delMap = new Map(delivered.map((r) => [r.so_item_id, n(r.qty)]));
  const retMap = new Map(returned.map((r) => [r.so_item_id, n(r.qty)]));

  const buckets = new Map();
  let specialsBearingDemandLines = 0;
  const specialsByCat = new Map();
  for (const d of demandRaw) {
    const cat = catByCode.get(d.item_code) ?? catFromGroup(d.item_group);
    if (isServiceLine({ itemGroup: d.item_group, itemCode: d.item_code, category: cat })) continue;
    const eff = Math.max(0, n(d.qty) - Math.max(0, (delMap.get(d.id) ?? 0) - (retMap.get(d.id) ?? 0)));
    if (eff <= 0) continue;
    const whId = resolveLineWarehouseId(
      d.warehouse_id, { sales_location: d.sales_location, customer_state: d.customer_state }, masters,
    );
    const vkey = computeVariantKey(d.item_group, d.variants ?? null);
    const k = composite(whId, d.item_code, vkey);
    const dated = Boolean(d.line_delivery_date ?? d.so_delivery_date);
    const sp = Array.isArray((d.variants ?? {}).specials) && (d.variants ?? {}).specials.length > 0;
    if (sp) {
      specialsBearingDemandLines += 1;
      const c = cat ?? "(uncatalogued)";
      specialsByCat.set(c, (specialsByCat.get(c) ?? 0) + 1);
    }
    const b = buckets.get(k) ?? {
      k, whId, code: d.item_code, vkey, cat: cat ?? "(uncatalogued)",
      path: cat === "SOFA" ? "sofa(S8)" : "general(S7)",
      needDated: 0, lines: 0, docs: new Set(),
    };
    b.lines += 1;
    if (dated) { b.needDated += eff; b.docs.add(d.doc_no); }
    buckets.set(k, b);
  }

  // ── stock (mrp.ts:605-612) ────────────────────────────────────────────────
  const bal = await sql`
    SELECT product_code, warehouse_id::text AS warehouse_id,
           coalesce(variant_key,'') AS variant_key, qty::numeric AS qty
      FROM scm.inventory_balances WHERE company_id = ${CO}::bigint`;
  const stockByKey = new Map();
  for (const b of bal) {
    const k = composite(b.warehouse_id ?? null, b.product_code, b.variant_key ?? "");
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + n(b.qty));
  }

  // ── open PO supply (mrp.ts:621-677) ───────────────────────────────────────
  const poRaw = await sql`
    SELECT p.po_number, p.status::text AS status, p.supplier_id::text AS supplier_id,
           p.purchase_location_id::text AS purchase_location_id,
           i.material_code, i.item_group, i.variants,
           i.qty::numeric AS qty, coalesce(i.received_qty,0)::numeric AS received_qty,
           i.warehouse_id::text AS warehouse_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE i.company_id = ${CO}::bigint
     ORDER BY i.id`;
  const poDrafts = [];
  let openLines = 0, openUnits = 0, emptyLines = 0, emptyUnits = 0;
  let misKeyedLines = 0, misKeyedUnits = 0;
  const misKeyedByGroup = new Map();
  const emptyPoMeta = new Map();
  for (const r of poRaw) {
    if (PO_DEAD.has(String(r.status ?? "").toUpperCase())) continue;
    const left = n(r.qty) - n(r.received_qty);
    if (left <= 0) continue;
    const poWh = r.warehouse_id ?? r.purchase_location_id ?? null;
    const vkey = computeVariantKey(r.item_group, r.variants ?? null);
    const k = composite(poWh, r.material_code, vkey);
    openLines += 1; openUnits += left;
    if (vkey === "") {
      emptyLines += 1; emptyUnits += left;
      const lost = carriesIdentity(r.variants);
      if (lost) {
        misKeyedLines += 1; misKeyedUnits += left;
        const g = `${r.item_group ?? "(null)"} -> lost ${lost}`;
        misKeyedByGroup.set(g, (misKeyedByGroup.get(g) ?? 0) + 1);
      }
      const cat = catByCode.get(r.material_code) ?? catFromGroup(r.item_group);
      const m = emptyPoMeta.get(k) ?? { whId: poWh, code: r.material_code, units: 0, cats: new Set() };
      m.units += left; m.cats.add(cat ?? "(uncatalogued)");
      emptyPoMeta.set(k, m);
    }
    poDrafts.push({ bucketKey: k, poNumber: r.po_number, eta: null, qtyLeft: left, supplierId: r.supplier_id ?? null });
  }

  // ── 4b. the app's OWN committed-shipment deduction (mrp.ts:687-716) ───────
  const openPoNumbers = [...new Set(poDrafts.map((d) => d.poNumber))];
  let committed = new Map();
  if (openPoNumbers.length > 0) {
    const movs = await sql`
      SELECT id::text AS id, warehouse_id::text AS warehouse_id, product_code,
             variant_key, batch_no, qty::numeric AS qty, source_doc_id::text AS source_doc_id
        FROM scm.inventory_movements
       WHERE company_id = ${CO}::bigint AND movement_type = 'OUT'
         AND source_doc_type = 'DO' AND batch_no = ANY(${openPoNumbers}::text[])`;
    const doIds = [...new Set(movs.map((m) => m.source_doc_id).filter(Boolean))];
    const doRows = doIds.length
      ? await sql`SELECT id::text AS id, status::text AS status, is_dropship
                    FROM scm.delivery_orders WHERE id = ANY(${doIds}::uuid[])`
      : [];
    const doById = new Map(doRows.map((d) => [d.id, d]));
    const lineRows = doIds.length
      ? await sql`SELECT delivery_order_id::text AS delivery_order_id, item_code,
                         committed_po_batch_no, committed_variant_key
                    FROM scm.delivery_order_items
                   WHERE delivery_order_id = ANY(${doIds}::uuid[])
                     AND committed_po_batch_no IS NOT NULL`
      : [];
    const committedLines = new Set(lineRows.map(
      (r) => `${r.delivery_order_id}|${r.item_code}|${r.committed_variant_key ?? ""}|${r.committed_po_batch_no}`));
    const movIds = movs.map((m) => m.id);
    const cons = movIds.length
      ? await sql`SELECT movement_id::text AS movement_id, qty_consumed::numeric AS qty_consumed
                    FROM scm.inventory_lot_consumptions WHERE movement_id = ANY(${movIds}::uuid[])`
      : [];
    const consumedByMovement = new Map();
    for (const r of cons) consumedByMovement.set(r.movement_id, (consumedByMovement.get(r.movement_id) ?? 0) + n(r.qty_consumed));
    const rows = [];
    for (const m of movs) {
      if (!m.batch_no || !m.source_doc_id) continue;
      const d = doById.get(m.source_doc_id);
      const variantKey = m.variant_key ?? "";
      rows.push({
        bucketKey: composite(m.warehouse_id ?? null, m.product_code, variantKey),
        warehouseId: m.warehouse_id ?? null, itemCode: m.product_code, variantKey,
        batchNo: m.batch_no, outQty: Math.abs(n(m.qty)), consumedQty: consumedByMovement.get(m.id) ?? 0,
        cancelled: !d || String(d.status ?? "").toUpperCase() === "CANCELLED",
        headerDropship: d?.is_dropship === true,
        lineCommitted: committedLines.has(`${m.source_doc_id}|${m.product_code}|${variantKey}|${m.batch_no}`),
      });
    }
    committed = outstandingCommitments(rows);
  }
  const supply = applyCommittedSupply(poDrafts, committed);
  for (const [bucketKey, addBack] of supply.stockAddBack) {
    stockByKey.set(bucketKey, (stockByKey.get(bucketKey) ?? 0) + addBack);
  }
  /* poByKey EXACTLY as the route builds it: from supply.entries only. */
  const poByKey = new Map();
  const poOutstandingByKey = new Map();
  for (const e of supply.entries) {
    const arr = poByKey.get(e.bucketKey) ?? [];
    arr.push(e); poByKey.set(e.bucketKey, arr);
    poOutstandingByKey.set(e.bucketKey, (poOutstandingByKey.get(e.bucketKey) ?? 0) + e.qtyLeft);
  }
  /* The RAW pool (no commitment deduction) — the earlier probe's predicate. */
  const rawQtyByKey = new Map();
  for (const d of poDrafts) rawQtyByKey.set(d.bucketKey, (rawQtyByKey.get(d.bucketKey) ?? 0) + d.qtyLeft);

  note("");
  note("--- A. the '' open PO pool, and how much of it is MIS-KEYED ---");
  note(`  open PO lines / units                      : ${openLines} / ${openUnits}`);
  note(`  ...keying ''                               : ${emptyLines} / ${emptyUnits}`);
  note(`  ...of THOSE, carrying real identity attrs in variants (the key LOST them,`);
  note(`     variant-key.ts:111 ATTRS_BY_GROUP[group] ?? []) : ${misKeyedLines} lines / ${misKeyedUnits} units`);
  for (const [g, cnt] of [...misKeyedByGroup].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    note(`       ${cnt.toString().padStart(4)}x  item_group=${g}`);
  }
  note(`  distinct (warehouse|code) '' pools open     : ${emptyPoMeta.size}`);

  // ── B. who draws it — MRP's predicate, both ways ──────────────────────────
  const rows = [];
  for (const b of buckets.values()) {
    const legacyKey = composite(b.whId, b.code, "");
    const ownPo = poByKey.get(b.k) ?? [];              // post-commitment, as the route sees it
    const ownRaw = rawQtyByKey.get(b.k) ?? 0;          // pre-commitment, as the earlier probe saw it
    const legacyPo = (poByKey.get(legacyKey) ?? []).reduce((a, e) => a + e.qtyLeft, 0);
    const useLegacyRoute = b.vkey !== "" && legacyKey !== b.k && ownPo.length === 0;
    const useLegacyRaw = b.vkey !== "" && legacyKey !== b.k && ownRaw === 0;
    const stock = stockByKey.get(b.k) ?? 0;
    const ownQty = ownPo.reduce((a, e) => a + e.qtyLeft, 0);
    const now = Math.max(0, b.needDated - stock - ownQty - (useLegacyRoute ? legacyPo : 0));
    const strict = Math.max(0, b.needDated - stock - ownQty);
    rows.push({ ...b, legacyKey, ownQty, ownRaw, legacyPo, useLegacyRoute, useLegacyRaw, stock, now, strict });
  }
  const eligible = rows.filter((r) => r.useLegacyRoute);
  const eligibleRaw = rows.filter((r) => r.useLegacyRaw);
  const fed = eligible.filter((r) => r.legacyPo > 0);
  const fedRaw = eligibleRaw.filter((r) => r.legacyPo > 0);
  const changed = fed.filter((r) => r.strict > r.now);
  const extraUnits = changed.reduce((a, r) => a + (r.strict - r.now), 0);

  note("");
  note("--- B. buckets the fallback actually feeds (MRP's own predicate) ---");
  note(`  demand buckets                                        : ${buckets.size}`);
  note(`  eligible  [route: ownPo AFTER committed deduction]     : ${eligible.length}`);
  note(`  eligible  [earlier probe: RAW open qty]                : ${eligibleRaw.length}`);
  note(`  buckets DRAWING a non-empty '' pool  <-- THE ANSWER    : ${fed.length}   (raw-predicate: ${fedRaw.length})`);
  note(`  rows whose shortage CHANGES if the fallback goes       : ${changed.length}`);
  note(`  extra shortage UNITS revealed                          : ${extraUnits}`);
  note(`  PO Outstanding (mrp.ts:903) inflated by the '' pool    : ${fed.reduce((a, r) => a + r.legacyPo, 0)} units`);
  for (const r of fed.slice(0, 20)) {
    note(`    ${whName.get(r.whId) ?? r.whId ?? WH_NONE}|${r.code}|${r.vkey}  cat=${r.cat} need=${r.needDated} stock=${r.stock} legPO=${r.legacyPo} ${r.now}->${r.strict}`);
  }

  // ── C. is the fallback really BEDFRAME/SOFA-only? ─────────────────────────
  const nonEmpty = rows.filter((r) => r.vkey !== "");
  const spOnly = nonEmpty.filter((r) => specialsOnlyKey(r.vkey));
  const spOnlyNonVB = spOnly.filter((r) => r.cat !== "BEDFRAME" && r.cat !== "SOFA");
  const byCatNonEmpty = new Map();
  for (const r of nonEmpty) byCatNonEmpty.set(r.cat, (byCatNonEmpty.get(r.cat) ?? 0) + 1);
  note("");
  note("--- C. the claim 'only BEDFRAME and SOFA can reach the fallback' ---");
  note("  variant-key.ts:132-133 appends `special=` for EVERY group, outside");
  note("  ATTRS_BY_GROUP — and mfg-pricing.ts:401-405 says special add-ons target");
  note("  MATTRESS deliberately (migration 0134). So a mattress/accessory line with");
  note("  a special add-on keys NON-EMPTY and IS eligible.");
  note(`  demand buckets with a NON-EMPTY key           : ${nonEmpty.length}`);
  note(`     by category : ${[...byCatNonEmpty].map(([c, v]) => `${c} ${v}`).join("   ") || "(none)"}`);
  note(`  ...whose key is specials-ONLY                 : ${spOnly.length}`);
  note(`  ...specials-only AND not bedframe/sofa  <-- the route the claim denies : ${spOnlyNonVB.length}`);
  for (const r of spOnlyNonVB.slice(0, 10)) {
    note(`       ${whName.get(r.whId) ?? r.whId ?? WH_NONE}|${r.code}|${r.vkey}  cat=${r.cat} need=${r.needDated} ownPO=${r.ownQty} legPO=${r.legacyPo}`);
  }
  note(`  LIVE SO lines carrying specials[]             : ${specialsBearingDemandLines}`);
  note(`     by category : ${[...specialsByCat].map(([c, v]) => `${c} ${v}`).join("   ") || "(none)"}`);

  // ── D. every '' pool accounted for (a zero must be explained) ─────────────
  const bucketsByWhCode = new Map();
  for (const r of rows) {
    const gk = `${r.whId ?? WH_NONE}|${r.code}`;
    const arr = bucketsByWhCode.get(gk) ?? [];
    arr.push(r); bucketsByWhCode.set(gk, arr);
  }
  const cls = { noDemand: 0, onlyEmptyDemand: 0, variantButOwnPo: 0, drew: 0 };
  const nearMiss = [];
  const variantDemandCodes = new Map();
  for (const r of rows) {
    if (r.vkey === "") continue;
    const a = variantDemandCodes.get(r.code) ?? new Set();
    a.add(r.whId ?? WH_NONE); variantDemandCodes.set(r.code, a);
  }
  for (const [lk, meta] of emptyPoMeta) {
    const group = bucketsByWhCode.get(`${meta.whId ?? WH_NONE}|${meta.code}`) ?? [];
    const variantBuckets = group.filter((r) => r.vkey !== "");
    if (group.length === 0) {
      cls.noDemand += 1;
      const elsewhere = variantDemandCodes.get(meta.code);
      if (elsewhere) nearMiss.push({ lk, units: meta.units, elsewhere: [...elsewhere] });
    } else if (variantBuckets.length === 0) cls.onlyEmptyDemand += 1;
    else if (variantBuckets.every((r) => !r.useLegacyRoute)) cls.variantButOwnPo += 1;
    else cls.drew += 1;
  }
  note("");
  note("--- D. every open '' pool classified (exit-zero is not success) ---");
  note(`  no live demand at that warehouse+code at all        : ${cls.noDemand}`);
  note(`  demand exists but ALL of it also keys '' (unreachable): ${cls.onlyEmptyDemand}`);
  note(`  has variant buckets, but none is eligible            : ${cls.variantButOwnPo}`);
  note(`  DID feed a variant bucket (must equal B)             : ${cls.drew}`);
  note(`  ---- sum ${cls.noDemand + cls.onlyEmptyDemand + cls.variantButOwnPo + cls.drew} must equal ${emptyPoMeta.size} open '' pools`);
  note(`  NEAR MISS ('' pool with no demand in ITS warehouse, but the same code has`);
  note(`  specific-variant demand in another warehouse)        : ${nearMiss.length}`);
  for (const w of nearMiss.slice(0, 10)) note(`       ${w.lk} units=${w.units} variant demand in: ${w.elsewhere.join(",")}`);

  // ── E. mis-keyed DEMAND (the mirror image) ───────────────────────────────
  let demandMisKeyed = 0;
  for (const d of demandRaw) {
    const vkey = computeVariantKey(d.item_group, d.variants ?? null);
    if (vkey === "" && carriesIdentity(d.variants)) demandMisKeyed += 1;
  }
  note("");
  note("--- E. the mirror: LIVE SO lines keyed '' that carry identity attrs ---");
  note(`  (their demand bucket is '' too, so the fallback never applies — but each`);
  note(`   one is a bedframe/sofa whose identity the key already dropped)  : ${demandMisKeyed}`);

  return { fed: fed.length, fedRaw: fedRaw.length, extraUnits, misKeyedLines, spOnlyNonVB: spOnlyNonVB.length, specialsBearingDemandLines, nearMiss: nearMiss.length };
}

async function main() {
  const companies = ONLY_CO != null ? [ONLY_CO]
    : (await sql`SELECT DISTINCT company_id FROM scm.mfg_sales_orders WHERE company_id IS NOT NULL ORDER BY company_id`)
        .map((r) => Number(r.company_id));
  note(`companies: ${JSON.stringify(companies)}`);
  const totals = [];
  for (const co of companies) totals.push([co, await runCompany(co)]);
  note("");
  note("======== ROLL-UP ========");
  for (const [co, t] of totals) {
    note(`  company ${co}: fed(route)=${t.fed} fed(raw)=${t.fedRaw} extraShortage=${t.extraUnits} | misKeyed '' PO lines=${t.misKeyedLines} | specials-only non-BF/SOFA buckets=${t.spOnlyNonVB} | live SO lines with specials=${t.specialsBearingDemandLines} | nearMiss=${t.nearMiss}`);
  }
  note("  READ-ONLY — SELECTs only, no writes.");
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* closed */ }
  process.exit(1);
});
