#!/usr/bin/env node
/* READ-ONLY. Answers the owner's "A 跟着我的 autocount 的先" question with numbers.
 *
 * WHY. backfill-specials-into-variants.mjs refuses to APPLY because some of the
 * picker codes it would stamp carry a price in scm.special_addons, and a picked
 * code's selling surcharge folds into the authoritative unit price
 * (mfg-pricing.ts:396/400/405 -> unitPriceSen :408-415, charged at
 * mfg-pricing-recompute.ts:435, persisted :600). Stamping a PRICED code onto a
 * migrated line therefore reprices a historical document on its next recompute.
 *
 * This script writes NOTHING. It reports, per priced code:
 *   1. the catalogue price;
 *   2. every MIGRATED line that would gain it, with that line's unit_price_sen
 *      and its AutoCount coordinates (linked_ac_docno / linked_ac_dtlkey) so the
 *      ERP figure can be compared against the AutoCount document by hand;
 *   3. how many NON-MIGRATED lines already carry it — the number that decides
 *      whether zeroing the code is safe for FUTURE orders.
 *
 * The mapping below MIRRORS backfill-specials-into-variants.mjs. Cross-check:
 * the per-code tallies of the two scripts must agree; if they diverge, this
 * audit is stale and its conclusions must not be trusted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { parseBedframe } from "./lib/parse-bedframe.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = JSON.parse(fs.readFileSync(path.join(here, "data", "special-order-phrase-map.json"), "utf8"));

const K = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const skey = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/NILON/g, "NYLON");
const flat = (s) => " " + String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " ";
const rx = (src) => (src ? new RegExp(src) : null);

const FAMILIES = MAP.families.map((f) => ({ ...f, _yes: rx(f.yes), _no: rx(f.no) }));
const SWAPS = MAP.cushionSwapModels;

function mapPhrase(raw, live, cat) {
  const s = flat(raw);
  const out = new Set();
  for (const f of FAMILIES) {
    if (!f.categories.includes(cat)) continue;
    if (f._no && f._no.test(s)) continue;
    if (!f._yes.test(s)) continue;
    const code = live.get(K(f.code));
    if (code) out.add(code);
  }
  if (cat === "SOFA" && /\bback ?rest\b|\bback ?cushion\b/.test(s) && !/\b(5537|5540)\b/.test(s)) {
    for (const [model, want] of SWAPS) {
      if (!new RegExp(`\\b${model}\\b`).test(s)) continue;
      const nums = s.match(/\b\d{4}\b/g) || [];
      if (nums.length > 1 && nums[nums.length - 1] !== model) continue;
      const code = live.get(K(want));
      if (code) out.add(code);
    }
  }
  return [...out];
}

function phrasesOf(list) {
  const phrases = [];
  for (const t of list) {
    const v = String(t ?? "").replace(/\s+/g, " ").trim();
    const k = skey(v);
    if (!k) continue;
    let merged = false;
    for (let i = 0; i < phrases.length; i++) {
      const e = skey(phrases[i]);
      if (e.includes(k)) { merged = true; break; }
      if (k.includes(e)) { phrases[i] = v; merged = true; break; }
    }
    if (!merged) phrases.push(v);
  }
  return phrases;
}
const asArray = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

async function main() {
  log(`READ-ONLY special-addon price audit. company=${CO}`);

  // ── 1. the catalogue ────────────────────────────────────────────────────────
  const addons = await sql`SELECT code, label, categories, active, selling_price_sen, cost_price_sen
    FROM scm.special_addons WHERE company_id = ${CO} ORDER BY code`;
  log("");
  log(`=== scm.special_addons (company ${CO}): ${addons.length} rows ===`);
  log(`   ${"sell".padStart(7)} ${"cost".padStart(7)}  active  categories        code`);
  for (const r of addons)
    log(`   ${String(r.selling_price_sen ?? 0).padStart(7)} ${String(r.cost_price_sen ?? 0).padStart(7)}` +
        `  ${r.active === false ? "  no  " : " yes  "}  ${(r.categories || []).join("+").padEnd(16)}  [${r.code}]`);

  const priceOf = new Map(addons.map((r) => [r.code, {
    sell: Number(r.selling_price_sen ?? 0), cost: Number(r.cost_price_sen ?? 0),
  }]));
  const PRICED = addons.filter((r) => Number(r.selling_price_sen ?? 0) || Number(r.cost_price_sen ?? 0))
                       .map((r) => r.code);
  log("");
  log(`PRICED codes in the catalogue: ${PRICED.length} -> ${PRICED.join(", ") || "(none)"}`);

  const liveByCat = new Map();
  for (const cat of ["SOFA", "BEDFRAME"]) {
    const m = new Map();
    for (const r of addons) {
      if (!(r.categories || []).some((c) => String(c).toUpperCase() === cat)) continue;
      m.set(K(r.code), r.code);
      if (r.label) m.set(K(r.label), r.code);
    }
    liveByCat.set(cat, m);
  }

  // ── 2. the migrated lines the backfill would touch ──────────────────────────
  /* COLUMN NAMES. The recompute's `unit_price_sen` is persisted into the column
     `unit_price_centi` (mfg-sales-orders.ts:4291) — there is NO `unit_price_sen`
     column on either line table. Reading a `_sen` column here would just error;
     summing one would prove nothing. SO totals live in `total_centi`, PO totals
     in `line_total_centi`. */
  const soLines = await sql`SELECT i.id, i.doc_no AS doc, i.item_code AS code, i.item_group AS grp,
      i.description2 AS d2, i.variants, i.unit_price_centi AS unit_centi, i.total_centi AS tot_centi,
      i.line_no, i.linked_ac_dtlkey, h.linked_ac_docno AS acdoc, h.migrated_no_stock AS migrated
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL`;
  const poLines = await sql`SELECT i.id, h.po_number AS doc, i.material_code AS code, i.item_group AS grp,
      i.description2 AS d2, i.variants, i.unit_price_centi AS unit_centi, i.line_total_centi AS tot_centi,
      NULL::int AS line_no, i.linked_ac_dtlkey, h.linked_ac_docno AS acdoc, h.migrated_no_stock AS migrated
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group IN ('sofa','bedframe') AND h.linked_ac_docno IS NOT NULL`;
  log("");
  log(`migrated lines scanned: SO ${soLines.length}, PO ${poLines.length}`);

  /* DOES THE SURCHARGE ACTUALLY REACH THE CHARGED PRICE?
     `breakdown.specialsSurchargeSen` enters the charge ONLY through
     `breakdown.unitPriceSen` at mfg-pricing-recompute.ts:435
     (`authoritativeSellingSen = effectiveBaseSen + breakdown.unitPriceSen`),
     and that value is used only when
     `hasAuthoritativeSelling = category !== 'SOFA' && effectiveBaseSen > 0` (:436).
     The SOFA branch prices from `computeSofaSellingSen + fabricAddonCenti +
     extraSen` (:563) and never adds the specials surcharge; in the whole
     recompute file `specialsSurchargeSen` appears only in a comment (:369) and
     as the persisted reporting field `special_order_sen` (:603).
     So a line only really reprices when it is BEDFRAME *and* its product row
     carries sell_price_sen > 0. Everything else keeps the operator's price. */
  const prods = await sql`SELECT code, sell_price_sen FROM scm.mfg_products WHERE company_id = ${CO}`;
  const sellOf = new Map(prods.map((p) => [K(p.code), Number(p.sell_price_sen ?? 0)]));
  log(`mfg_products loaded for the sell_price_sen test: ${prods.length}`);

  const byCode = new Map();          // code -> lines that would GAIN it
  const affected = [];               // per-line detail, priced codes only

  for (const [which, rows] of [["SO", soLines], ["PO", poLines]]) {
    for (const r of rows) {
      const cat = r.grp === "sofa" ? "SOFA" : "BEDFRAME";
      const live = liveByCat.get(cat);
      let raw = [];
      if (r.d2) {
        if (cat === "SOFA") {
          let model = String(r.code || "").split("-")[0].toUpperCase();
          model = SOFA_MODEL_ALIAS[model] || model;
          raw = parseSofa(r.d2, model, false).specials || [];
        } else {
          raw = parseBedframe(r.d2).specials || [];
        }
      }
      const phrases = phrasesOf(raw);
      if (!phrases.length) continue;

      const gained = new Set();
      for (const p of phrases) {
        if (live.has(K(p))) { gained.add(live.get(K(p))); continue; }
        for (const c of mapPhrase(p, live, cat)) gained.add(c);
      }
      if (!gained.size) continue;

      const v = (r.variants && typeof r.variants === "object" && !Array.isArray(r.variants)) ? r.variants : {};
      const had = [...new Set([...asArray(v.specials), ...asArray(v.special)].map((x) => String(x).trim()).filter(Boolean))];
      const addedNow = [...gained].filter((c) => !had.some((x) => K(x) === K(c)));
      if (!addedNow.length) continue;

      for (const c of addedNow) byCode.set(c, (byCode.get(c) || 0) + 1);

      const pricedAdded = addedNow.filter((c) => PRICED.some((p) => K(p) === K(c)));
      if (pricedAdded.length) {
        const delta = pricedAdded.reduce((a, c) => a + (priceOf.get(c)?.sell || 0), 0);
        const deltaCost = pricedAdded.reduce((a, c) => a + (priceOf.get(c)?.cost || 0), 0);
        const sellBase = sellOf.get(K(r.code)) ?? 0;
        const reprices = cat !== "SOFA" && sellBase > 0;
        affected.push({
          which, doc: r.doc, line_no: r.line_no, id: r.id, code: r.code, cat,
          unit_centi: Number(r.unit_centi ?? 0), tot_centi: Number(r.tot_centi ?? 0),
          acdoc: r.acdoc, acdtl: r.linked_ac_dtlkey, migrated: r.migrated,
          codes: pricedAdded, delta, deltaCost, sellBase, reprices,
        });
      }
    }
  }

  // ── 3. per-code tally + the money ───────────────────────────────────────────
  log("");
  log(`=== per-code tally: lines that would GAIN the code ===`);
  for (const [c, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    const p = priceOf.get(c) || { sell: 0, cost: 0 };
    const tag = (p.sell || p.cost) ? `   <-- PRICED sell=${p.sell} cost=${p.cost}` : "";
    log(`   ${String(n).padStart(4)}  ${c}${tag}`);
  }

  log("");
  log(`=== THE AFFECTED LINES (would gain a PRICED code) : ${affected.length} ===`);
  log(`   ${"src".padEnd(3)} ${"doc".padEnd(16)} ${"item_code".padEnd(20)} ${"cat".padEnd(8)} ` +
      `${"unit_centi".padStart(11)} ${"sellbase".padStart(9)} ${"+delta".padStart(7)} ${"REPRICES".padEnd(8)} ` +
      `${"ac_docno".padEnd(12)} ${"ac_dtlkey".padStart(9)}  codes`);
  let totalDelta = 0, totalDeltaCost = 0, realDelta = 0;
  for (const a of affected.sort((x, y) => String(x.doc).localeCompare(String(y.doc)))) {
    totalDelta += a.delta; totalDeltaCost += a.deltaCost;
    if (a.reprices) realDelta += a.delta;
    log(`   ${a.which.padEnd(3)} ${String(a.doc ?? "").padEnd(16)} ${String(a.code ?? "").padEnd(20)} ` +
        `${a.cat.padEnd(8)} ${String(a.unit_centi).padStart(11)} ${String(a.sellBase).padStart(9)} ` +
        `${String(a.delta).padStart(7)} ${(a.reprices ? "YES" : "no").padEnd(8)} ` +
        `${String(a.acdoc ?? "").padEnd(12)} ${String(a.acdtl ?? "").padStart(9)}  ${a.codes.join("+")}`);
  }
  log("");
  log(`   NOMINAL selling exposure (sum of stamped prices): ${totalDelta} sen (RM ${(totalDelta / 100).toFixed(2)})`);
  log(`   REAL SELLING exposure: ${realDelta} sen (RM ${(realDelta / 100).toFixed(2)}) on ` +
      `${affected.filter((a) => a.reprices).length} of ${affected.length} lines`);
  log(`     - only a BEDFRAME line with mfg_products.sell_price_sen > 0 takes the`);
  log(`       authoritative path (recompute :435/:436); SOFA prices from`);
  log(`       computeSofaSellingSen + fabric + extraSen (:563) and never adds specials.`);
  log(`   REAL COST exposure   : ${totalDeltaCost} sen (RM ${(totalDeltaCost / 100).toFixed(2)}) on ALL ${affected.length} lines`);
  log(`     - cost has no SOFA exemption: unitCostSen = costBreakdown.unitPriceSen (:463),`);
  log(`       and the sofa module-cost branch re-adds the same surcharges (:490-491,`);
  log(`       "line-level cost surcharges (sofa leg / specials) stay on top").`);
  log(`     - so MARGIN moves on every affected line even where the price does not.`);
  const nonMigratedAffected = affected.filter((a) => a.migrated !== true).length;
  log(`   of these lines, header migrated_no_stock<>true: ${nonMigratedAffected}`);

  // machine-readable, for joining against AutoCount off-line
  log("");
  log("AFFECTED_JSON_BEGIN");
  console.log(JSON.stringify(affected));
  log("AFFECTED_JSON_END");

  // ── 4. who ELSE already uses these codes (decides whether zeroing is safe) ──
  log("");
  log(`=== CURRENT usage of each PRICED code in variants.specials ===`);
  log(`   (migrated = header linked_ac_docno IS NOT NULL; live = the rest)`);
  log(`   ${"code".padEnd(34)} ${"SO_mig".padStart(7)} ${"SO_live".padStart(8)} ${"PO_mig".padStart(7)} ${"PO_live".padStart(8)}`);
  for (const code of PRICED) {
    const j = JSON.stringify([code]);
    const so = await sql`SELECT
        COUNT(*) FILTER (WHERE h.linked_ac_docno IS NOT NULL) AS mig,
        COUNT(*) FILTER (WHERE h.linked_ac_docno IS NULL)     AS live
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = ${CO} AND COALESCE(i.variants->'specials','[]'::jsonb) @> ${j}::jsonb`;
    const po = await sql`SELECT
        COUNT(*) FILTER (WHERE h.linked_ac_docno IS NOT NULL) AS mig,
        COUNT(*) FILTER (WHERE h.linked_ac_docno IS NULL)     AS live
      FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      WHERE h.company_id = ${CO} AND COALESCE(i.variants->'specials','[]'::jsonb) @> ${j}::jsonb`;
    log(`   ${code.padEnd(34)} ${String(so[0].mig).padStart(7)} ${String(so[0].live).padStart(8)} ` +
        `${String(po[0].mig).padStart(7)} ${String(po[0].live).padStart(8)}`);
  }

  log("");
  log("READ-ONLY audit complete. Nothing was written.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
