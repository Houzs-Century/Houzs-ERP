// Read-only: why do stock buckets go negative while a sibling bucket of the same
// item and warehouse holds stock nobody consumes? Because the DO that ships a
// product built a different variant_key from the GRN that received it. This
// check measures HOW the two keys differ, per company, so the canonical-key fix
// targets the right fields. Phase 1 of the variant-key repair: nothing written.
//
//   A. Negative buckets: net movements < 0, no open lot, an OUT on or after
//      CUTOVER (default 2026-08-29). Counts by family, by OUT source type, and
//      how many have a sibling (same item + warehouse) holding open lots.
//   B. Chain: every DO whose OUT made a negative bucket negative. DO line ->
//      SO line (delivery_order_items.so_item_id) -> PO line
//      (purchase_order_items.so_item_id, or purchase_order_item_allocations) ->
//      posted GRN line (grn_items.purchase_order_item_id). The DO line's key is
//      compared with the closest GRN line key and classified:
//      field-one-side, format, different-value, grn-no-spec, do-no-spec,
//      po-no-grn, no-po-link, same-key. Plus which side moved off the SO key.
//   C. Siblings: each negative bucket's key against the closest sibling bucket
//      that holds stock, classified the same way (covers stock sold without a
//      PO, where B has no chain to follow).
//
// Keys are recomputed with computeVariantKey (src/scm/shared/variant-key.ts),
// the function every stock writer uses, from each line's item_group + variants.
//
// PUBLIC LOG: the repository's Actions logs are public. This prints document
// numbers, item codes, warehouse codes, variant keys, quantities and counts
// only — never an amount, a cost, a customer name or a phone number.
//
//   node backend/scripts/check-variant-key-drift.mjs      (via tsx: imports .ts)
//   Actions -> "Run a backend script on production": script
//   check-variant-key-drift.mjs, mode plan, optional env
//   COMPANY_ID=1;CUTOVER=2026-08-29;LIMIT=20
//
// SELECTs only, in one READ ONLY transaction; every query names company_id.
// Exits 0 for every real answer (zero findings is an answer). Only a missing
// DATABASE_URL, an unreachable database or a query error exits non-zero.
import "./lib/public-log-guard.mjs";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import { computeVariantKey } from "../src/scm/shared/variant-key.ts";
import {
  CLASSES, DEFAULT_CUTOVER, DEFAULT_LIMIT, intEnv, classifyPair, classifyChain, closestKey,
  diffLabels, driftSide, isNegativeAfterCutover, tally, itemFamily,
} from "./lib/variant-key-drift.mjs";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const LIMIT = intEnv(process.env.LIMIT, DEFAULT_LIMIT, 200);
const CUTOVER = /^\d{4}-\d{2}-\d{2}$/.test(process.env.CUTOVER ?? "") ? process.env.CUTOVER : DEFAULT_CUTOVER;
const ONLY_COMPANY = process.env.COMPANY_ID ? Number.parseInt(process.env.COMPANY_ID, 10) : null;

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const keyOf = (group, variants) => computeVariantKey(group, variants && typeof variants === "object" ? variants : {});
const show = (k) => (k == null ? "-" : k === "" ? "(empty)" : k);
const bucketId = (item, wh, vk) => `${item}\u0001${wh}\u0001${vk}`;
let failures = 0;

function printTally(label, rows, max = 40) {
  console.log(`  ${label}:`);
  if (rows.length === 0) console.log("    (none)");
  for (const [k, n] of rows.slice(0, max)) console.log(`    ${n}  ${k}`);
  if (rows.length > max) console.log(`    ... ${rows.length - max} more`);
}

function printClasses(label, results, fmt) {
  notice(`${label}: ${results.length} finding(s)`);
  printTally("by class", tally(results, (r) => r.cls));
  printTally("by field (a finding can name several)", tally(results.filter((r) => r.diffs.length), (r) => diffLabels(r.diffs)));
  for (const [cls, desc] of CLASSES) {
    const rows = results.filter((r) => r.cls === cls);
    if (rows.length === 0) continue;
    console.log(`\n  [${cls}] ${rows.length} — ${desc}`);
    for (const r of rows.slice(0, LIMIT)) console.log(`    ${fmt(r)}`);
    if (rows.length > LIMIT) console.log(`    ... ${rows.length - LIMIT} more`);
  }
}

async function runCompany(sql, co) {
  const buckets = await sql`
    WITH mv AS (
      SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk,
             SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int AS net,
             MAX(created_at) FILTER (WHERE movement_type = 'OUT') AS last_out
        FROM scm.inventory_movements WHERE company_id = ${co} GROUP BY 1, 2, 3),
    lt AS (
      SELECT item_code, warehouse_id, COALESCE(variant_key, '') AS vk, SUM(qty_remaining)::int AS open
        FROM scm.inventory_lots WHERE company_id = ${co} GROUP BY 1, 2, 3)
    SELECT COALESCE(mv.item_code, lt.item_code) AS "itemCode",
           COALESCE(mv.warehouse_id, lt.warehouse_id)::text AS "warehouseId",
           COALESCE(w.code, w.name, LEFT(COALESCE(mv.warehouse_id, lt.warehouse_id)::text, 8)) AS warehouse,
           COALESCE(mv.vk, lt.vk) AS vk,
           COALESCE(mv.net, 0) AS "movementNet", COALESCE(lt.open, 0) AS "lotOpen", mv.last_out AS "lastOutAt"
      FROM mv FULL JOIN lt ON lt.item_code = mv.item_code AND lt.warehouse_id = mv.warehouse_id AND lt.vk = mv.vk
      LEFT JOIN scm.warehouses w ON w.id = COALESCE(mv.warehouse_id, lt.warehouse_id) AND w.company_id = ${co}`;
  const negative = buckets.filter((b) => isNegativeAfterCutover(b, CUTOVER));
  const stocked = buckets.filter((b) => Number(b.lotOpen) > 0);
  const siblingsOf = (b) => stocked.filter((s) => s.itemCode === b.itemCode && s.warehouseId === b.warehouseId && s.vk !== b.vk);

  console.log("\n-- A. negative buckets --");
  const withSibling = negative.filter((b) => siblingsOf(b).length > 0);
  notice(`company ${co}: ${negative.length} negative bucket(s) after ${CUTOVER}; ${negative.filter((b) => b.vk !== "").length} with a non-empty variant_key; ${withSibling.length} have a sibling bucket holding stock`);
  if (negative.length === 0) return;
  printTally("by family", tally(negative, (b) => itemFamily(b.itemCode)), 30);

  const negIds = new Set(negative.map((b) => bucketId(b.itemCode, b.warehouseId, b.vk)));
  const codes = [...new Set(negative.map((b) => b.itemCode))];
  const outs = await sql`
    SELECT m.item_code AS "itemCode", m.warehouse_id::text AS "warehouseId", COALESCE(m.variant_key, '') AS vk,
           COALESCE(m.source_doc_type, '(none)') AS "srcType", m.source_doc_id::text AS "docId", m.source_doc_no AS "docNo",
           SUM(m.qty)::int AS qty
      FROM scm.inventory_movements m
     WHERE m.company_id = ${co} AND m.movement_type = 'OUT' AND m.created_at >= ${CUTOVER}
       AND m.item_code = ANY(${codes})
     GROUP BY 1, 2, 3, 4, 5, 6`;
  const negOuts = outs.filter((o) => negIds.has(bucketId(o.itemCode, o.warehouseId, o.vk)));
  printTally("OUT movements into them since cutover, by source type (rows)", tally(negOuts, (o) => o.srcType));

  // ---- B. chain ----
  console.log("\n-- B. DO line -> SO line -> PO line -> GRN line --");
  const doOuts = negOuts.filter((o) => o.srcType === "DO" && o.docId);
  const doIds = [...new Set(doOuts.map((o) => o.docId))];
  const doLines = doIds.length === 0 ? [] : await sql`
    SELECT i.id::text AS id, i.delivery_order_id::text AS "doId", d.do_number AS "doNo", d.so_doc_no AS "soDocNo",
           i.item_code AS "itemCode", i.item_group AS "itemGroup", i.variants, i.so_item_id::text AS "soItemId"
      FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
     WHERE d.company_id = ${co} AND i.delivery_order_id::text = ANY(${doIds}) AND i.item_code = ANY(${codes})`;
  const soItemIds = [...new Set(doLines.map((l) => l.soItemId).filter(Boolean))];
  const soLines = soItemIds.length === 0 ? [] : await sql`
    SELECT s.id::text AS id, s.doc_no AS "docNo", s.item_group AS "itemGroup", s.variants
      FROM scm.mfg_sales_order_items s WHERE s.company_id = ${co} AND s.id::text = ANY(${soItemIds})`;
  const poLines = soItemIds.length === 0 ? [] : await sql`
    SELECT pi.id::text AS id, po.po_number AS "poNo", pi.item_group AS "itemGroup", pi.variants,
           COALESCE(pi.so_item_id, a.so_item_id)::text AS "soItemId"
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
      LEFT JOIN scm.purchase_order_item_allocations a
             ON a.purchase_order_item_id = pi.id AND a.company_id = ${co} AND a.so_item_id::text = ANY(${soItemIds})
     WHERE po.company_id = ${co}
       AND (pi.so_item_id::text = ANY(${soItemIds}) OR a.so_item_id IS NOT NULL)`;
  const poIds = [...new Set(poLines.map((p) => p.id))];
  const grnLines = poIds.length === 0 ? [] : await sql`
    SELECT gi.purchase_order_item_id::text AS "poItemId", g.grn_number AS "grnNo", po.po_number AS "poNo",
           gi.item_group AS "itemGroup", gi.variants
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
      JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
      JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${co}
     WHERE g.company_id = ${co} AND g.status IN ('POSTED', 'CLOSED')
       AND gi.purchase_order_item_id::text = ANY(${poIds})`;
  console.log(`  DOs: ${doIds.length}, DO lines: ${doLines.length}, SO lines: ${soLines.length}, PO lines: ${poLines.length}, posted GRN lines: ${grnLines.length}`);

  const soById = new Map(soLines.map((s) => [s.id, { ...s, key: keyOf(s.itemGroup, s.variants) }]));
  const posBySo = new Map();
  for (const p of poLines) {
    const arr = posBySo.get(p.soItemId) ?? [];
    if (!arr.some((x) => x.id === p.id)) arr.push({ ...p, key: keyOf(p.itemGroup, p.variants) });
    posBySo.set(p.soItemId, arr);
  }
  const grnKeyed = grnLines.map((g) => ({ ...g, key: keyOf(g.itemGroup, g.variants) }));

  const chain = [];
  for (const o of doOuts) {
    const lines = doLines.filter((l) => l.doId === o.docId && l.itemCode === o.itemCode)
      .map((l) => ({ ...l, key: keyOf(l.itemGroup, l.variants) }));
    // The DO line that produced this OUT: same recomputed key. If the line was
    // edited after ship, no line matches; keep every line of the item and say so.
    const exact = lines.filter((l) => l.key === o.vk);
    const used = exact.length > 0 ? exact : lines;
    if (used.length === 0) {
      chain.push({ cls: "no-po-link", diffs: [], o, line: null, so: null, ref: null, note: "no DO line for the movement" });
      continue;
    }
    for (const line of used) {
      const pos = posBySo.get(line.soItemId) ?? [];
      const r = classifyChain(o.vk, line.soItemId, pos, grnKeyed);
      const so = soById.get(line.soItemId) ?? null;
      chain.push({
        ...r, o, line, so,
        side: r.ref && r.cls !== "po-no-grn" ? driftSide(so?.key ?? null, o.vk, r.ref.key) : "unknown",
        note: exact.length > 0 ? "" : `DO line key now ${show(line.key)} (edited after ship?)`,
      });
    }
  }
  printClasses(`[B] company ${co} DO OUT key vs GRN key of the same SO line`, chain, (r) => [
    r.o.docNo ?? "-", r.so?.docNo ?? r.line?.soDocNo ?? "-",
    r.ref?.poNo ? `PO ${r.ref.poNo}` : "PO -", r.ref?.grnNo ? `GRN ${r.ref.grnNo}` : "GRN -",
    r.o.itemCode, `qty ${r.o.qty}`,
    `DO ${show(r.o.vk)}`, `GRN/PO ${show(r.ref?.key)}`, `SO ${show(r.so?.key)}`, r.note,
  ].filter(Boolean).join(" | "));
  printTally("which side moved off the SO line key (DO = SO and GRN agree, DO differs)",
    tally(chain.filter((r) => r.side && r.side !== "unknown"), (r) => r.side));

  // ---- C. siblings ----
  console.log("\n-- C. negative bucket vs the closest sibling bucket holding stock --");
  const sib = [];
  for (const b of negative) {
    const near = closestKey(b.vk, siblingsOf(b).map((s) => s.vk));
    if (!near) continue;
    const s = siblingsOf(b).find((x) => x.vk === near.key);
    sib.push({ cls: near.cls, diffs: near.diffs, b, s });
  }
  console.log(`  negative buckets with no sibling holding stock: ${negative.length - sib.length}`);
  printClasses(`[C] company ${co} negative bucket key vs closest stocked sibling`, sib, (r) =>
    `${r.b.itemCode} @ ${r.b.warehouse} | negative ${show(r.b.vk)} net=${r.b.movementNet} | stocked ${show(r.s.vk)} open=${r.s.lotOpen}`);
  // Sanity: a sibling pair classified the same way as B tells the fix is general.
  const pairCheck = sib.filter((r) => classifyPair(r.b.vk, r.s.vk).cls !== r.cls).length;
  if (pairCheck > 0) console.log(`  (internal: ${pairCheck} sibling classification(s) disagreed on re-check)`);
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  await pg.begin("read only", async (sql) => {
    const cos = ONLY_COMPANY ? [ONLY_COMPANY] : (await sql`
      SELECT company_id FROM scm.inventory_movements WHERE company_id IS NOT NULL GROUP BY 1 ORDER BY 1`).map((r) => Number(r.company_id));
    notice(`variant-key drift: cutover ${CUTOVER}, companies ${cos.join(", ")}, up to ${LIMIT} examples per class`);
    for (const co of cos) {
      console.log(`\n================ company ${co} ================`);
      await sql.savepoint((sp) => runCompany(sp, co))
        .catch((e) => { failures += 1; console.error(`  company ${co} query failed: ${e.message}`); });
    }
  });
} finally {
  await pg.end({ timeout: 5 });
}
if (failures > 0) {
  console.error(`${failures} company run(s) failed; the companies above that printed counts are still valid.`);
  process.exit(1);
}
