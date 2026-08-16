#!/usr/bin/env node
/* BEFORE vs AFTER for the MRP variant-supply boundary change. READ-ONLY.
 *
 * Two things changed on 2026-08-16, under one owner rule — 变体不同 = 不同的东西，
 * 不能拿来抵 (a different variant is a DIFFERENT ITEM and may not satisfy the
 * order):
 *
 *  1. routes/mrp.ts dropped the EMPTY-variant ('') PO fallback. A specific-
 *     variant demand bucket with no PO supply of its own used to fold in the
 *     same-warehouse '' PO pool, so a PO for an UNSPECIFIED bedframe/sofa
 *     covered demand for a specific fabric/gap/divan/leg/height.
 *  2. shared/variant-key.ts stopped emitting '' for an UNRECOGNISED item_group.
 *     `ATTRS_BY_GROUP[group] ?? []` meant a NULL, blank or misspelt group threw
 *     away every attribute the line carried and keyed '' — so one PO line
 *     written with a null item_group landed in the unclassified bucket and (via
 *     1) covered every variant of that SKU. It now keys `!group=<group>|<attrs>`,
 *     which can collide with no real bucket and with no '' bucket.
 *
 * BOTH ERAS ARE COMPUTED FROM ONE READ, so before/after is a difference of
 * arithmetic over identical rows, not two runs against a moving database. The
 * AFTER key is the app's real computeVariantKey (imported, never re-derived);
 * the BEFORE key is DERIVED FROM IT rather than hand-copied — see
 * preQuarantineKey below, and the test that pins the derivation
 * (src/scm/shared/variant-key.test.ts covers the forward direction).
 *
 * Run under tsx so the TS modules import for real:
 *     npx tsx scripts/probe-variant-supply-boundary.mjs
 *
 * WHY BUCKET ARITHMETIC IS EXACT AND NOT AN APPROXIMATION (inherited verbatim
 * from probe-mrp-legacy-variant-fallback.mjs, which measured era 1 alone): MRP's
 * greedy walk drains two pools (stock, then the PO queue) line by line, so the
 * bucket's TOTAL shortage is order-independent — max(0, need - stock - poSupply).
 * The page runs includeUndated=false and undated lines sort LAST (byDateAsc puts
 * nulls after every date), so undated demand can only consume what the dated
 * lines left behind -> the visible shortage is exactly
 * max(0, DATED need - stock - poSupply). applyCommittedSupply moves units from
 * the PO pool into stockAddBack in the SAME bucketKey, so (stock + poSupply) is
 * unchanged by commitments; it also drops zero-qty entries, which makes MRP's
 * `ownPo.length === 0` test identical to ownPoQty === 0.
 *
 * WRITES NOTHING. SELECT and information_schema only.
 *
 * Env: DATABASE_URL (required), COMPANY (default 1), VERBOSE=1 for per-row detail.
 */
import postgres from "postgres";
import { computeVariantKey, UNKNOWN_GROUP_SLUG } from "../src/scm/shared/variant-key.ts";
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

/* The key this code USED to produce, derived from the key it produces now —
 * not a second implementation of the rule. Pre-change, an unrecognised group
 * emitted NO identity attributes: `ATTRS_BY_GROUP[group] ?? []` was empty, so
 * the whole key was the specials segment, or ''. Post-change the same input
 * emits `!group=…|<attrs>|special=…`. Stripping the quarantine prefix and the
 * attribute segments therefore reconstructs the old key exactly; every other
 * key is byte-identical across the two eras. */
const preQuarantineKey = (k) => {
  if (!k.startsWith(`${UNKNOWN_GROUP_SLUG}=`)) return k;
  return k.split("|").find((p) => p.startsWith("special=")) ?? "";
};

/* routes/mrp.ts — the ONLY two statuses MRP treats as dead PO supply. Not the
   CANCELLED/CLOSED/DRAFT triple some older probes used: a CLOSED PO still
   counts as supply, and getting that wrong changes every number. */
const PO_DEAD = new Set(["CANCELLED", "DRAFT"]);

/* routes/mrp.ts catFromGroup — the fallback category for an SO line whose
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

/* shared/variant-key.ts ATTRS_BY_GROUP — the groups the key recognises. Kept
   here only to LABEL the census; the key itself is never recomputed locally. */
const KNOWN_GROUPS = new Set(["sofa", "bedframe", "mattress", "accessory", "others", "service"]);

const n = (v) => Number(v ?? 0);
const pad = (v, w) => String(v).padStart(w);

async function main() {
  note(`\n${"=".repeat(78)}`);
  note(`MRP variant-supply boundary — BEFORE vs AFTER, company ${CO}`);
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

  // ── demand: MRP's own lens ─────────────────────────────────────────────────
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

  /* delivered net of returns per SO line — soDeliverableRemaining's own rule:
     active DO lines only (parent NOT CANCELLED and NOT DRAFT), returns traced
     through those same DO lines with a non-CANCELLED parent DR. */
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

  /* ── buckets, in BOTH eras. `newKey` is the app's live function; `oldKey` is
        the same string with the quarantine stripped. A row whose group is
        recognised has oldKey === newKey, so the two bucket maps differ ONLY
        where the group is unrecognised AND the line carried attributes. */
  const bucketsNew = new Map();
  const bucketsOld = new Map();
  let skippedService = 0;
  let demandKeyMoved = 0;
  const put = (map, k, seed, eff, dated) => {
    const b = map.get(k) ?? { ...seed, needDated: 0, needAll: 0, lines: 0, linesDated: 0, docs: new Set() };
    b.needAll += eff; b.lines += 1;
    if (dated) { b.needDated += eff; b.linesDated += 1; b.docs.add(seed.doc); }
    map.set(k, b);
    return b;
  };
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
    const vNew = computeVariantKey(d.item_group, d.variants ?? null);
    const vOld = preQuarantineKey(vNew);
    if (vNew !== vOld) demandKeyMoved += 1;
    const dated = Boolean(d.line_delivery_date ?? d.so_delivery_date);
    const path = cat === "SOFA" ? "sofa(§8)" : "general(§7)";
    put(bucketsNew, composite(whId, d.item_code, vNew),
      { whId, code: d.item_code, vkey: vNew, cat, path, doc: d.doc_no }, eff, dated);
    put(bucketsOld, composite(whId, d.item_code, vOld),
      { whId, code: d.item_code, vkey: vOld, cat, path, doc: d.doc_no }, eff, dated);
  }

  // ── stock (stored keys — unaffected by either change) ──────────────────────
  const bal = await sql`
    SELECT product_code, warehouse_id::text AS warehouse_id,
           coalesce(variant_key,'') AS variant_key, qty::numeric AS qty
      FROM scm.inventory_balances
     WHERE company_id = ${CO}::bigint`;
  const stockByKey = new Map();
  let emptyKeyStockRows = 0, emptyKeyStockUnits = 0;
  for (const b of bal) {
    const k = composite(b.warehouse_id ?? null, b.product_code, b.variant_key ?? "");
    stockByKey.set(k, (stockByKey.get(k) ?? 0) + n(b.qty));
    if ((b.variant_key ?? "") === "" && n(b.qty) !== 0) { emptyKeyStockRows += 1; emptyKeyStockUnits += n(b.qty); }
  }

  // ── open PO supply, in both eras ───────────────────────────────────────────
  const poRaw = await sql`
    SELECT p.po_number, p.status, p.purchase_location_id::text AS purchase_location_id,
           i.material_code, i.item_group, i.variants AS variants,
           i.qty::numeric AS qty, coalesce(i.received_qty,0)::numeric AS received_qty,
           i.warehouse_id::text AS warehouse_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE i.company_id = ${CO}::bigint
     ORDER BY i.id`;
  const poQtyNew = new Map();
  const poQtyOld = new Map();
  const poLinesByOldKey = new Map();
  let openPoLines = 0, openPoUnits = 0, emptyKeyPoLines = 0, emptyKeyPoUnits = 0, poKeyMoved = 0;
  for (const r of poRaw) {
    if (PO_DEAD.has(String(r.status ?? "").toUpperCase())) continue;
    const left = n(r.qty) - n(r.received_qty);
    if (left <= 0) continue;
    const poWh = r.warehouse_id ?? r.purchase_location_id ?? null;
    const vNew = computeVariantKey(r.item_group, r.variants ?? null);
    const vOld = preQuarantineKey(vNew);
    if (vNew !== vOld) poKeyMoved += 1;
    openPoLines += 1; openPoUnits += left;
    if (vOld === "") { emptyKeyPoLines += 1; emptyKeyPoUnits += left; }
    const kNew = composite(poWh, r.material_code, vNew);
    const kOld = composite(poWh, r.material_code, vOld);
    poQtyNew.set(kNew, (poQtyNew.get(kNew) ?? 0) + left);
    poQtyOld.set(kOld, (poQtyOld.get(kOld) ?? 0) + left);
    const arr = poLinesByOldKey.get(kOld) ?? [];
    arr.push(`${r.po_number}(${r.status},${left})`);
    poLinesByOldKey.set(kOld, arr);
  }

  // ── SECTION A — the size of the '' PO pool the fallback drew on ────────────
  note(`\n--- A. the empty-variant ('') PO pool ---`);
  note(`  open PO lines (status not ${[...PO_DEAD].join("/")}, qty>received): ${openPoLines}  units left ${openPoUnits}`);
  note(`  ...of which key '' (pre-change basis):                            ${emptyKeyPoLines}  units left ${emptyKeyPoUnits}`);
  note(`  distinct (warehouse, code) groups holding an open '' pool:        ${[...poQtyOld.keys()].filter((k) => k.endsWith("|")).length}`);
  note(`  inventory_balances rows sitting in the '' bucket with qty<>0:     ${emptyKeyStockRows}  units ${emptyKeyStockUnits}`);
  note(`     (stock is keyed by its STORED variant_key — neither change rewrites a stored key)`);

  // ── SECTION B/C — shortage BEFORE vs AFTER ─────────────────────────────────
  /* BEFORE = pre-change keys + the '' fallback. AFTER = live keys, own pool only. */
  const shortageOf = (buckets, poQty, withFallback) => {
    const rows = [];
    for (const b of buckets.values()) {
      const key = composite(b.whId, b.code, b.vkey);
      const legacyKey = composite(b.whId, b.code, "");
      const ownPo = poQty.get(key) ?? 0;
      const legacyPo = poQty.get(legacyKey) ?? 0;
      // MRP's exact predicate. ownPo.length===0 <=> ownPo qty 0 (see header).
      const useLegacy = withFallback && b.vkey !== "" && legacyKey !== key && ownPo === 0;
      const stock = stockByKey.get(key) ?? 0;
      const short = Math.max(0, b.needDated - stock - ownPo - (useLegacy ? legacyPo : 0));
      rows.push({ ...b, key, legacyKey, ownPo, legacyPo, useLegacy, stock, short, poOut: ownPo + (useLegacy ? legacyPo : 0) });
    }
    return rows;
  };
  const before = shortageOf(bucketsOld, poQtyOld, true);
  const after = shortageOf(bucketsNew, poQtyNew, false);

  const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
  const shortRows = (rows) => rows.filter((r) => r.short > 0 && r.linesDated > 0);

  note(`\n--- B. what the retired fallback was feeding ---`);
  const fed = before.filter((r) => r.useLegacy && r.legacyPo > 0);
  note(`  demand buckets, BEFORE keys: ${bucketsOld.size}     AFTER keys: ${bucketsNew.size}`);
  note(`  specific-variant buckets eligible for the fallback (no own PO):   ${before.filter((r) => r.useLegacy).length}`);
  note(`  ...that actually drew a NON-EMPTY '' pool:                        ${fed.length}`);
  note(`     general (§7) ${fed.filter((r) => r.path.startsWith("general")).length}   sofa (§8) ${fed.filter((r) => r.path.startsWith("sofa")).length}`);
  note(`  dated SO lines in those buckets:                                  ${sum(fed, (r) => r.linesDated)}`);
  note(`  dated units in those buckets:                                     ${sum(fed, (r) => r.needDated)}`);
  note(`  SKIPPED as SERVICE lines (never demand):                          ${skippedService}`);

  note(`\n--- C. THE ANSWER — MRP shortage rows, BEFORE vs AFTER ---`);
  note(`  The page runs includeUndated=false and onlyShort defaults FALSE, so a demand`);
  note(`  bucket is already a row either way. What moves is how many rows are ORANGE`);
  note(`  (shortage>0) and how many units they are short by.`);
  const sBefore = shortRows(before), sAfter = shortRows(after);
  note(`  shortage ROWS   before ${pad(sBefore.length, 6)}   after ${pad(sAfter.length, 6)}   delta ${sAfter.length - sBefore.length}`);
  note(`  shortage UNITS  before ${pad(sum(sBefore, (r) => r.short), 6)}   after ${pad(sum(sAfter, (r) => r.short), 6)}   delta ${sum(sAfter, (r) => r.short) - sum(sBefore, (r) => r.short)}`);
  note(`  PO Outstanding  before ${pad(sum(before, (r) => r.poOut), 6)}   after ${pad(sum(after, (r) => r.poOut), 6)}   delta ${sum(after, (r) => r.poOut) - sum(before, (r) => r.poOut)}`);
  note(`  EXPECTED: all three deltas 0. A non-zero delta is stock the business`);
  note(`  believes it has and does not — report it, do not wave it through.`);

  const beforeByKey = new Map(before.map((r) => [r.key, r]));
  const changed = after
    .map((r) => ({ r, was: beforeByKey.get(r.key) }))
    .filter(({ r, was }) => (was ? was.short : 0) !== r.short);
  if (changed.length || VERBOSE) {
    note(`\n  bucket                                                   need  stock ownPO legPO  before->after`);
    for (const { r, was } of (VERBOSE ? after.map((x) => ({ r: x, was: beforeByKey.get(x.key) })) : changed)) {
      const label = `${(whName.get(r.whId) ?? r.whId ?? WH_NONE)}|${r.code}|${r.vkey}`;
      note(`  ${label.slice(0, 54).padEnd(54)} ${pad(r.needDated, 5)} ${pad(r.stock, 6)} ${pad(r.ownPo, 5)} ${pad(r.legacyPo, 5)}  ${was ? was.short : "-"}->${r.short}   ${r.path}  ${[...r.docs].slice(0, 4).join(",")}`);
      note(`      '' pool lines: ${(poLinesByOldKey.get(r.legacyKey) ?? []).join(" ") || "(none)"}`);
    }
  }

  // ── SECTION D — ONE '' pool feeding MORE THAN ONE bucket (the N-fold count) ─
  const drawers = new Map();
  for (const r of fed) {
    const arr = drawers.get(r.legacyKey) ?? [];
    arr.push(r);
    drawers.set(r.legacyKey, arr);
  }
  const multi = [...drawers.entries()].filter(([, arr]) => arr.length > 1);
  note(`\n--- D. one '' pool folded into MORE THAN ONE variant bucket (pre-change) ---`);
  note(`  Each eligible bucket cloned the pool independently, so N buckets each got the`);
  note(`  FULL qty. '' pools drawn by 2+ buckets: ${multi.length}`);
  for (const [lk, arr] of multi) {
    const pool = poQtyOld.get(lk) ?? 0;
    const drawn = arr.reduce((a, r) => a + Math.min(pool, Math.max(0, r.needDated - r.stock)), 0);
    note(`   ${lk}  pool=${pool}  buckets=${arr.length}  claimed=${drawn}  OVER=${Math.max(0, drawn - pool)}`);
  }

  // ── SECTION E — the item_group census (the hole that outlives the fallback) ─
  /* Tables are DISCOVERED, not listed: every scm table carrying BOTH an
     item_group and a variants column is a place a variant key is computed from
     a group, so a hand list here would go stale the next time one is added. */
  const KNOWN = [...KNOWN_GROUPS];
  const keyed = await sql`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND column_name = 'item_group'
    INTERSECT
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND column_name = 'variants'
    INTERSECT
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND column_name = 'company_id'
     ORDER BY 1`;
  note(`\n--- E. item_group census — where an UNRECOGNISED group would re-key ---`);
  note(`  recognised groups: ${KNOWN.join(", ")}`);
  note(`  tables discovered carrying (item_group, variants, company_id): ${keyed.length}`);
  note(`  ${"table".padEnd(38)} ${pad("rows", 8)} ${pad("unknwn", 7)} ${pad("KEYMOVE", 8)}  distinct unrecognised spellings`);
  let totalMoved = 0;
  for (const t of keyed) {
    const tbl = t.table_name;
    /* Count in SQL, pull only the rows that could possibly move — an
       unrecognised group is the ONLY input whose key changed. */
    const [{ total }] = await sql`
      SELECT count(*)::bigint AS total FROM scm.${sql(tbl)} WHERE company_id = ${CO}::bigint`;
    const rows = await sql`
      SELECT item_group, variants
        FROM scm.${sql(tbl)}
       WHERE company_id = ${CO}::bigint
         AND coalesce(lower(btrim(item_group)), '') <> ALL (${KNOWN}::text[])`;
    let moved = 0;
    const spellings = new Map();
    for (const r of rows) {
      const g = String(r.item_group ?? "").trim().toLowerCase();
      spellings.set(g, (spellings.get(g) ?? 0) + 1);
      const vNew = computeVariantKey(r.item_group, r.variants ?? null);
      if (vNew !== preQuarantineKey(vNew)) moved += 1;
    }
    totalMoved += moved;
    const sample = [...spellings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([g, c]) => `${g === "" ? "(null/blank)" : g}x${c}`).join(" ");
    note(`  ${tbl.padEnd(38)} ${pad(n(total), 8)} ${pad(rows.length, 7)} ${pad(moved, 8)}  ${sample}`);
  }
  note(`  ROWS WHOSE VARIANT KEY MOVES (total): ${totalMoved}`);
  note(`  demand lines whose key moves: ${demandKeyMoved}   open PO lines whose key moves: ${poKeyMoved}`);
  note(`  EXPECTED 0. A moved key re-buckets that row away from the stored`);
  note(`  inventory_balances.variant_key it used to match — loud (visible shortage /`);
  note(`  unmatched stock), never silent substitution, but still a number the owner`);
  note(`  must see before this merges.`);

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error(e);
  try { await sql.end({ timeout: 5 }); } catch { /* closed */ }
  process.exit(1);
});
