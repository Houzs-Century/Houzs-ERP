#!/usr/bin/env node
// Put the supplier's real price on the imported purchase-order lines that came
// in at zero.
//
// WHY THEY ARE ZERO. Houzs suppliers do not price a purchase order. The price
// appears on the GOODS RECEIVED document, so an unpriced PO line is normal
// paperwork, not a data fault: in live AutoCount HOOKKA is 2,264/2,264 PO lines
// unpriced, OHANA 100%, DORSETTLOFT 100%, while GRDTL is 17,377/19,013 priced
// (91.4%). The cutover copied that faithfully -- 565 of the 579 SO-linked PO
// lines carry unit_price_sen = 0.
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
//       FromDocNo + ItemCode + Desc2. (GRDTL.FromDocDtlKey -- the AutoCount GR
//       line's own pointer back to the PO line, INSIDE the AutoCount book -- is
//       unpopulated in AED_HOUZS, 0 of 21,001 rows, so the PO->GR link is the
//       doc number. Do not confuse it with scm.purchase_order_items
//       .linked_ac_dtlkey, which is the ERP-side key, IS populated, and is used
//       for TARGETING rather than pricing. Two different keys, one name.)
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
// ── WHICH ERP LINE EACH PRICE LANDS ON ─────────────────────────────────────
// scripts/lib/po-cost-plan.mjs decides that, and is the whole of the decision:
// three keys, all of which carry the ITEM CODE, because Desc2 alone does not.
// Desc2 is the fabric, the leg and the gap; the SIZE is in the code, so keying
// the target on the document + Desc2 alone let a king's price land on a queen.
// That module is unit-tested (tests/poCostPlan.node.mjs) against the two live
// lines it used to get wrong.
//
// SAFETY -- only touches lines that are all of:
//   . on a PO imported from AutoCount (purchase_orders.linked_ac_docno set),
//   . still unpriced (unit_price_sen = 0), so a hand-entered price is never
//     overwritten, and
//   . still open (received_qty < qty), so no settled receipt is re-costed.
// A line two AutoCount lines want at DIFFERENT prices is refused, not resolved.
// Idempotent: the unit_price_sen = 0 predicate means a second run finds
// nothing left to do.
// RE-RUN: inert. Every UPDATE re-asserts COALESCE(unit_price_sen, 0) = 0, so
// a second run plans the same lines and writes none of them, and a price a
// person entered in between is never clobbered.
//
// DRY-RUN by default; APPLY=1 writes. The dry-run prints ONE LINE PER PLANNED
// WRITE -- the same list APPLY walks -- so what a reviewer reads is what runs.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { planStamps, normCode, SKIP } from "./lib/po-cost-plan.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
/* This stamps MONEY onto production purchase lines, and a wrong cost is worse
   than no cost - a zero is visible and the receipt gate refuses it, a plausible
   wrong number is silent for the life of the unit. One environment variable is
   the same keystroke whether it is meant or mistyped, so the apply path also
   needs the phrase spelled out. */
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const CO = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

/** AutoCount ItemCode -> ERP material_code, the pair every cutover script uses. */
function loadCodeMap() {
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const m = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0] && f[1]) m.set(normCode(f[0]), normCode(f[1])); }
  return m;
}

const rm = (centi) => `RM${(centi / 100).toFixed(2)}`;
const short = (s, n) => { const t = (s ?? "").toString().replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const book = gz("ac-po-line-costs.json.gz");
  log(`AutoCount evidence: ${book.poLines.length} unpriced open PO lines, ${book.samePoGr.length} same-PO GR lines, ${book.history.length} priced history lines`);

  /* The ERP line is addressed by its AutoCount document plus its item code plus
     its Desc2 -- see lib/po-cost-plan.mjs for why all three. supplier_sku holds
     the RAW AutoCount ItemCode (the importer stores it verbatim) and
     linked_ac_dtlkey is the line's AutoCount identity where the key backfill
     has reached it, so both are read here and both are preferred over the
     mapping CSV. */
  const rows = await sql`
    SELECT i.id, i.material_code, i.supplier_sku, i.description2, i.qty, i.received_qty,
           i.unit_price_sen, i.linked_ac_dtlkey,
           h.linked_ac_docno AS ac_doc, h.po_number
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
     WHERE i.company_id = ${CO}
       AND h.linked_ac_docno IS NOT NULL
       AND COALESCE(i.unit_price_sen, 0) = 0
       AND COALESCE(i.received_qty, 0) < i.qty`;
  log(`ERP imported PO lines still unpriced and still open: ${rows.length}`);

  const { plan, skipped, stats } = planStamps({ book, erpRows: rows, codeMap: loadCodeMap() });

  const tiers = {};
  for (const p of plan) tiers[p.tier] = (tiers[p.tier] ?? 0) + 1;
  const units = plan.reduce((s, p) => s + p.qty, 0);
  const value = plan.reduce((s, p) => s + p.centi * p.qty, 0) / 100;

  log(`AutoCount open lines considered: ${stats.acOpenLines}; matched to an ERP line by dtlkey ${stats.matchedByDtlKey}, by supplier_sku+Desc2 ${stats.matchedBySupplierSku}, by material_code+Desc2 ${stats.matchedByMaterialCode}; no ERP line ${stats.acLinesWithNoErpLine}; no defensible price ${stats.acLinesWithNoPrice}`);
  for (const k of Object.keys(tiers).sort()) log(`priced by ${k}: ${tiers[k]} ERP lines`);
  log(`TO STAMP: ${plan.length} ERP PO lines, ${units} open units, RM ${value.toFixed(2)} of committed purchase value`);
  log(`LEFT AT ZERO: ${skipped.length} ERP PO lines, ${skipped.reduce((s, k) => s + (Number(k.row.qty) - Number(k.row.received_qty ?? 0)), 0)} open units`);

  /* EXACTLY what APPLY writes, one line each, with the AutoCount line the money
     came from. The previous version printed a per-AutoCount-line narrative that
     could say "LEFT AT ZERO x3" about a line the plan then stamped; this list
     IS the plan, so the two can no longer disagree. */
  log(`-- planned writes (${plan.length}) --`);
  for (const p of plan) {
    log(`   UPDATE ${p.id} ${p.poNumber} (${p.acDoc}) ${p.code} x${p.qty} := ${rm(p.centi)} [${p.tier} via ${p.route}] from AC ${p.fromAcItemCode}${p.fromAcDtlKey ? ` #${p.fromAcDtlKey}` : ""} "${short(p.fromAcDesc2, 48)}"`);
  }

  const byReason = new Map();
  for (const s of skipped) {
    if (!byReason.has(s.reason)) byReason.set(s.reason, []);
    byReason.get(s.reason).push(s);
  }
  log(`-- left at zero, by reason --`);
  for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const u = list.reduce((s, k) => s + (Number(k.row.qty) - Number(k.row.received_qty ?? 0)), 0);
    log(`   ${reason}: ${list.length} lines / ${u} units`);
    const worst = new Map();
    for (const k of list) worst.set(k.row.material_code, (worst.get(k.row.material_code) ?? 0) + (Number(k.row.qty) - Number(k.row.received_qty ?? 0)));
    for (const [code, u2] of [...worst.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) log(`      ${code} x${u2}`);
  }
  /* An ambiguous line is the one a reviewer must see in full: it is where two
     AutoCount lines wanted different money on the same ERP row. */
  for (const s of skipped.filter((k) => k.reason === SKIP.AMBIGUOUS)) {
    log(`   AMBIGUOUS ${s.row.id} ${s.row.po_number} (${s.row.ac_doc}) ${s.row.material_code}: ${s.prices.map(rm).join(" vs ")} from ${s.from.map((f) => f.ItemCode).join(", ")} -- refused, left at zero`);
  }

  if (!APPLY) { log("DRY-RUN -- set APPLY=1 to write."); await sql.end(); return; }
  let done = 0, skippedWrite = 0;
  for (const p of plan) {
    /* Re-assert the zero predicate inside the write so a price entered by hand
       between the read and here is never clobbered, and a re-run is a no-op. */
    const res = await sql`
      UPDATE scm.purchase_order_items
         SET unit_price_sen = ${p.centi},
             line_total_sen = ${p.centi} * qty
       WHERE id = ${p.id} AND COALESCE(unit_price_sen, 0) = 0`;
    if (res.count > 0) done += res.count; else skippedWrite++;
  }
  /* plan holds one entry per ERP id, so `done` short of plan.length is never a
     partial failure -- it is a line that acquired a price between the read and
     the write, and the predicate correctly declined to overwrite it. */
  log(`DONE. PO lines priced: ${done}; already priced by someone else since the read, left alone: ${skippedWrite}; planned: ${plan.length}`);
  await sql.end();

  /* VERIFY ON A SECOND CONNECTION, reading the VALUES back. The session that
     wrote is the worst witness that the write landed: on 2026-08-13 a repair
     reported "written: 7 of 7" over seven rows it had actually turned into
     jsonb strings. A count is not a shape - and here the shape is money. */
  const check = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  try {
    log("");
    log("VERIFY (fresh connection) - reading the priced rows back:");
    const ids = plan.slice(0, 300).map((p) => p.id);
    if (!ids.length) { log("  nothing planned, nothing to read back."); return; }
    const rows = await check`SELECT id::text AS id, unit_price_sen, line_total_sen, qty
                               FROM scm.purchase_order_items WHERE id = ANY(${ids})`;
    const by = new Map(rows.map((r) => [r.id, r]));
    let ok = 0, wrong = 0, stillZero = 0;
    for (const p of plan.slice(0, 300)) {
      const r = by.get(String(p.id));
      if (!r) continue;
      const price = Number(r.unit_price_sen ?? 0);
      if (price === 0) { stillZero++; continue; }
      const total = Number(r.line_total_sen ?? 0);
      if (price === p.centi && total === p.centi * Number(r.qty ?? 0)) ok++;
      else { wrong++; log(`  MISMATCH ${p.id}: unit ${price} (wanted ${p.centi}), line total ${total} (wanted ${p.centi * Number(r.qty ?? 0)})`); }
    }
    log(`  read back ${ok + wrong + stillZero} row(s): ${ok} carry the intended price, ${wrong} do not, ${stillZero} are still zero (declined by the guard, or not reached).`);
    if (wrong) { console.error("VERIFY FAILED - the rows do not read back as intended."); process.exitCode = 1; }
    else log("  VERIFY PASS");
  } finally {
    await check.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
