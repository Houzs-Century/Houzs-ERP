#!/usr/bin/env node
// Put the supplier's real price on the imported purchase-order lines that came
// in at zero.
//
// WHY THEY ARE ZERO. Houzs suppliers do not price a purchase order. The price
// appears on the GOODS RECEIVED document, so an unpriced PO line is normal
// paperwork, not a data fault: in live AutoCount HOOKKA is 2,264/2,264 PO lines
// unpriced, OHANA 100%, DORSETTLOFT 100%, while GRDTL is 17,377/19,013 priced
// (91.4%). The cutover copied that faithfully -- 565 of the 579 SO-linked PO
// lines carry unit_price_centi = 0.
//
// WHY IT MATTERS. Nothing downstream puts a cost back. On the next receipt the
// zero rides purchase_order_items -> grn_items -> the FIFO trigger's IN branch
// (COALESCE(NEW.unit_cost_sen, 0); the weighted-average fallback exists only in
// the ADJUSTMENT branch) -> a zero-cost lot -> RM0 COGS -> 100% margin.
//
// ── HOW EACH LINE IS PRICED, and why not the obvious way ───────────────────
//
// NOT by MAX(UnitPrice) from PIDTL joined on ItemCode. One AutoCount item code
// covers many builds, and one purchase invoice carries several of them, so MAX
// reaches across to a bigger sofa on the same invoice. Backtested over all
// 11,239 priced purchase lines for these 67 item codes -- predict each line's
// price from the others, compare to what was actually paid:
//
//   rule                                exact    MAPE     overstates >5%
//   MAX(UnitPrice) by item code          2.1%   112.5%          97.6%
//   LAST purchase cost by item code      9.7%    32.2%          57.2%
//   item + Desc2 signature              97.3%     0.4%           1.5%
//   supplier + item + Desc2             98.0%     0.4%             --
//
// Desc2 -- the compartment/colour signature -- IS the price key, and neither
// MAX nor last-cost is fit to stamp money. That rules out pricing these lines
// from data/ac-last-purchase-costs.json.gz: it is a last-cost-by-item table, so
// it would cover far more lines at roughly a third average error. A wrong cost
// is worse than no cost -- a zero is visible and the receipt gate refuses it,
// while a plausible-looking wrong number is silent for the life of the unit.
// So this script prices only what it can price accurately and REPORTS the rest.
//
// The waterfall, best evidence first:
//   T1  the goods-received line raised against THIS VERY PO line, matched on
//       FromDocNo + ItemCode + Desc2. (GRDTL.FromDocDtlKey is unpopulated in
//       AED_HOUZS -- 0 of 21,001 rows -- so the PO->GR link is the doc number.)
//   T2  the same item + the same Desc2 signature anywhere in the book, most
//       recent. Measured 97.3% exact, 0.4% MAPE.
//   T3  the item is PRICE-STABLE: at least 4 priced purchases in the last 24
//       months with 80% of them within 2% of the median -- pillows, standard
//       divans. Measured 4.8% MAPE, overstating by more than 5% on 1.6%.
//   otherwise LEFT AT ZERO and listed, for the receipt gate to catch.
//
// Six item codes have no price anywhere in the book and can never be stamped:
// AMN-SF9021 SOFA, BC-CBK818(SK), DSL-8069 SOFA, HOK-1051 (Q), HOK-1052 (SP),
// HOK-2038 (A)(HF)(W) (SS).
//
// SAFETY -- only touches lines that are all of:
//   . on a PO imported from AutoCount (purchase_orders.linked_ac_docno set),
//   . still unpriced (unit_price_centi = 0), so a hand-entered price is never
//     overwritten, and
//   . still open (received_qty < qty), so no settled receipt is re-costed.
// Idempotent: the unit_price_centi = 0 predicate means a second run finds
// nothing left to do.
// DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

/* Desc2 carries curly quotes, inch marks written three different ways, stray
   newlines and doubled spaces. Fold all of that away so the same physical build
   keyed by two different typists still matches. */
const sig = (s) => (s ?? "").toString().toUpperCase()
  .replace(/[‘’“”`]/g, '"')
  .replace(/''/g, '"')
  .replace(/[^A-Z0-9"#+]/g, "");

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

function buildPricer(book) {
  const hist = [...book.history].sort((a, b) => (a.DocDate < b.DocDate ? -1 : 1));
  const byItemSig = new Map();
  for (const h of hist) {
    const k = `${h.ItemCode}|${sig(h.Desc2)}`;
    if (!byItemSig.has(k)) byItemSig.set(k, []);
    byItemSig.get(k).push(h);
  }
  const samePo = new Map();
  for (const g of book.samePoGr) {
    if (Number(g.UnitPrice) > 0) samePo.set(`${g.PoNo}|${g.ItemCode}|${sig(g.Desc2)}`, Number(g.UnitPrice));
  }
  /* PRICE-STABLE items only: enough recent evidence, and that evidence agrees.
     A bespoke sofa never qualifies, which is the point -- its price is a
     property of the build, not of the code. */
  const cutoff = Date.now() - 24 * 30 * 24 * 3600 * 1000;
  const stable = new Map();
  for (const item of new Set(hist.map((h) => h.ItemCode))) {
    const ps = hist.filter((h) => h.ItemCode === item && new Date(h.DocDate).getTime() >= cutoff).map((h) => Number(h.UnitPrice));
    if (ps.length < 4) continue;
    const m = median(ps);
    if (ps.filter((p) => Math.abs(p - m) / m <= 0.02).length / ps.length >= 0.8) stable.set(item, m);
  }
  return (line) => {
    const s = sig(line.Desc2);
    const t1 = samePo.get(`${line.PoNo}|${line.ItemCode}|${s}`);
    if (t1 > 0) return { tier: "T1_gr_for_this_po_line", price: t1 };
    const t2 = byItemSig.get(`${line.ItemCode}|${s}`);
    if (t2 && t2.length) return { tier: "T2_item_desc2_signature", price: Number(t2[t2.length - 1].UnitPrice) };
    const t3 = stable.get(line.ItemCode);
    if (t3 > 0) return { tier: "T3_price_stable_item", price: t3 };
    return null;
  };
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const book = gz("ac-po-line-costs.json.gz");
  log(`AutoCount evidence: ${book.poLines.length} unpriced open PO lines, ${book.samePoGr.length} same-PO GR lines, ${book.history.length} priced history lines`);
  const priceOf = buildPricer(book);

  /* Match the ERP line by the AutoCount document it came from plus its Desc2,
     which the importer stored verbatim in description2. The PO NUMBER is not a
     key -- the ERP renumbers on import -- and the AutoCount DtlKey was never
     stored, so (linked_ac_docno, description2) is the identifying pair. Two ERP
     lines sharing both are the same physical build and take the same price. */
  const rows = await sql`
    SELECT i.id, i.material_code, i.description2, i.qty, i.received_qty, i.unit_price_centi,
           h.linked_ac_docno AS ac_doc, h.po_number
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
     WHERE i.company_id = ${CO}
       AND h.linked_ac_docno IS NOT NULL
       AND COALESCE(i.unit_price_centi, 0) = 0
       AND COALESCE(i.received_qty, 0) < i.qty`;
  log(`ERP imported PO lines still unpriced and still open: ${rows.length}`);

  const bySigKey = new Map();
  for (const r of rows) {
    const k = `${r.ac_doc}|${sig(r.description2)}`;
    if (!bySigKey.has(k)) bySigKey.set(k, []);
    bySigKey.get(k).push(r);
  }

  const plan = [];
  const tiers = {};
  const unmatchedItems = new Map();
  let unmatchedUnits = 0, noErpLine = 0;
  for (const line of book.poLines) {
    const open = Number(line.Qty) - Number(line.TransferedQty ?? 0);
    if (!(open > 0)) continue;
    const hit = priceOf(line);
    if (!hit) {
      unmatchedUnits += open;
      unmatchedItems.set(line.ItemCode, (unmatchedItems.get(line.ItemCode) ?? 0) + open);
      continue;
    }
    const targets = bySigKey.get(`${line.PoNo}|${sig(line.Desc2)}`) ?? [];
    if (targets.length === 0) { noErpLine++; continue; }
    for (const t of targets) {
      plan.push({ id: t.id, poNumber: t.po_number, acDoc: line.PoNo, code: t.material_code, tier: hit.tier, centi: Math.round(hit.price * 100), qty: Number(t.qty) - Number(t.received_qty ?? 0) });
      tiers[hit.tier] = (tiers[hit.tier] ?? 0) + 1;
    }
  }

  const value = plan.reduce((s, p) => s + p.centi * p.qty, 0) / 100;
  for (const k of Object.keys(tiers).sort()) log(`priced by ${k}: ${tiers[k]} ERP lines`);
  log(`to stamp: ${plan.length} ERP PO lines, ${plan.reduce((s, p) => s + p.qty, 0)} open units, RM ${value.toFixed(2)} of committed purchase value`);
  log(`left at zero (no defensible price -- bespoke build, or no price anywhere): ${unmatchedItems.size} item codes / ${unmatchedUnits} units`);
  log(`AutoCount lines with no matching open ERP line (already received or not imported): ${noErpLine}`);
  for (const p of plan) log(`   ${p.poNumber} (${p.acDoc}) ${p.code} x${p.qty} @ RM${(p.centi / 100).toFixed(2)} [${p.tier}]`);
  const worst = [...unmatchedItems.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [code, units] of worst) log(`   LEFT AT ZERO ${code} x${units}`);

  if (!APPLY) { log("DRY-RUN -- set APPLY=1 to write."); await sql.end(); return; }
  let done = 0;
  for (const p of plan) {
    /* Re-assert the zero predicate inside the write so a price entered by hand
       between the read and here is never clobbered, and a re-run is a no-op. */
    const res = await sql`
      UPDATE scm.purchase_order_items
         SET unit_price_centi = ${p.centi},
             line_total_centi = ${p.centi} * qty
       WHERE id = ${p.id} AND COALESCE(unit_price_centi, 0) = 0`;
    done += res.count;
  }
  log(`DONE. PO lines priced: ${done} (of ${plan.length} planned)`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
