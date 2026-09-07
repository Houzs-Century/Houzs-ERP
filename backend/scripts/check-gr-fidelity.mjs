#!/usr/bin/env node
/* GOODS RECEIPTS — did the ERP record the receipts AutoCount actually made?
 *
 * Owner, 2026-09-07, before tallying stock against AutoCount:
 *   "可是 DO GR 你都检查对了？"
 *
 * WHY THIS CHECK HAD TO EXIST. `check-migration-fidelity.mjs` prints, for the
 * GR section, "line and money comparison NOT APPLICABLE" and stops. Its reason
 * is sound as far as it goes — `grn_items.qty_received` is DERIVED from the PO
 * line, and one ERP GRN covers a whole PO while an AutoCount receipt can span
 * several, so a naive line-for-line comparison would measure the derivation
 * rather than the book. But "not applicable" was then read as "checked", and
 * the contents of 320 migrated goods receipts have never been compared to
 * AutoCount at all.
 *
 * THE AXIS THAT IS COMPARABLE. AutoCount's GRDTL carries no key back to the PO
 * line (`ac-fidelity-manifest.json`: 0 of 21,001 rows), so the finest grain
 * that survives the export is (PO document, item code) — which is exactly what
 * `ac-fidelity-gr-by-po-item.json.gz` holds. Above that sits the PO document
 * total, which is immune to both the item-code mapping and to sofa
 * decomposition, and below everything sits a question that needs no arithmetic
 * at all:
 *
 *   Did AutoCount receive ANYTHING against this purchase order?
 *
 * A migrated GRN on a PO that AutoCount never received against is a receipt the
 * ERP invented. That test is presence-versus-absence, it cannot be confounded
 * by sofa compartments or by a code map, and it is the headline of this check.
 *
 * THE SNAPSHOT MUST BE THE FRESHEST ONE, AND THE FIRST VERSION OF THIS CHECK
 * GOT THAT WRONG. Run 34134695504 reported "86 of 320 migrated goods receipts
 * INVENTED — AutoCount never received against this purchase order". It was
 * measured against `ac-fidelity-*`, cut 2026-08-11. Checked against
 * `ac-convert-edges.json.gz`, cut from the live book 2026-09-07 08:39, ALL 40
 * of the 40 named purchase orders had in fact been received — between the two
 * cuts. 145 purchase orders received more in that window and none received
 * less. The ERP was right and the check was a month behind, which is precisely
 * the shape of `docs/bugs/0666`: a comparison that cannot see one of its own
 * axes reports the axis as a defect.
 *
 * So the receipt truth here is `ac-convert-edges.json.gz` — PODTL per line,
 * with `itemKey` and `transferedQty`, from the live book — and the older
 * `ac-fidelity-*` pair is kept only as a SECOND measure. Where the two
 * disagree the answer is the fresh one, and the gap is reported as STALE rather
 * than as a finding. The check prints both timestamps and refuses to call
 * anything invented on the strength of the older cut alone.
 *
 * THREE INDEPENDENT AUTOCOUNT MEASURES, cross-checked before any is used as
 * truth: PODTL.TransferedQty from the live export (primary), the same column
 * from the 2026-08-11 cut, and SUM(GRDTL.Qty) over the receipt documents
 * themselves. They are written by different parts of AutoCount and cut at
 * different times. This check prints how far they agree; where the two
 * SAME-VINTAGE measures disagree it says so and treats the PO as UNVERIFIABLE
 * rather than picking a winner.
 *
 * SOFA IS A SHAPE DIFFERENCE, NOT A DIVERGENCE. One AutoCount sofa line becomes
 * one ERP line per COMPARTMENT, and the importer writes the SAME received
 * quantity onto every compartment. Summing the ERP side therefore multiplies a
 * sofa receipt by its compartment count. So the quantity comparison is reported
 * SEPARATELY for purchase orders that carry no sofa line — where the sum is
 * exact and the verdict is real — and for those that do, where the shape
 * difference is named instead of being averaged into a percentage.
 *
 * READ-ONLY on both systems. SELECT only, no writes, no DDL, no transaction.
 * The AutoCount side is the committed snapshot from
 * backend/scripts/export-ac-fidelity-truth.py — the AutoCount host sits behind
 * ZeroTier on the office network and a CI runner is not on it.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     default 1
 *   TOP            example rows printed per finding, default 25
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const TOP = Number(process.env.TOP ?? 25);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m = "") => console.log(m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

const norm = (s) => (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ");
const n0 = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r0 = (v) => Math.round(n0(v));
const pad = (v, w) => String(v).padStart(w);

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur); return out;
}

async function main() {
  const started = Date.now();
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "data", "ac-fidelity-manifest.json"), "utf8"));
  const acPoL = gz("ac-fidelity-po-lines.json.gz");
  const acGr = gz("ac-fidelity-gr-by-po-item.json.gz");
  /* THE PRIMARY TRUTH. Cut from the live book, so it is the only source allowed
     to decide that a receipt AutoCount does not know about is a defect. */
  const edges = gz("ac-convert-edges.json.gz");
  const EL = edges.line_fields;
  const eIdx = (n) => { const i = EL.indexOf(n); if (i < 0) throw new Error(`ac-convert-edges has no line field "${n}"`); return i; };
  const eDoc = eIdx("docNo"), eItem = eIdx("itemKey"), eTrans = eIdx("transferedQty");
  const edgePoLines = edges.types?.PO?.lines ?? [];
  if (!edgePoLines.length) throw new Error("ac-convert-edges carries no PO lines; this check cannot answer");

  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const mapAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) mapAc.set(norm(f[0]), (f[1] || "").trim()); }
  const erpCodeOf = (acItem) => mapAc.get(norm(acItem)) || null;
  const acIsSofa = (code) => /SOFA/i.test(code || "") || /-1S$/i.test(erpCodeOf(code) || "");

  const ageDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  log("=".repeat(96));
  log("GOODS RECEIPTS — did the ERP record the receipts AutoCount actually made?");
  log("=".repeat(96));
  log("THE TWO SNAPSHOTS, and which one decides:");
  log(`  PRIMARY  ac-convert-edges.json.gz   ${edges.exported_at}   ${edgePoLines.length} PO lines`);
  log(`  second   ac-fidelity-*              ${manifest.exported_at}   ${manifest.counts.po_lines} PO lines, gr_by_po_item ${manifest.counts.gr_by_po_item}`);
  log(`  the second cut is ${ageDays(manifest.exported_at, edges.exported_at)} day(s) older. NOTHING is called a defect on its strength alone:`);
  log("  the first version of this check did exactly that and reported 86 invented receipts that the");
  log("  live book had simply received after the older cut was taken.");
  log(`  GRDTL rows carrying a line-level key back to the PO line: ${manifest.grdtl_rows_with_line_key} of ${manifest.grdtl_rows}`);
  log("  -> the finest grain either export preserves is (PO document, item code). Everything below is");
  log("     reported at that grain or coarser, and never pretends to a line identity it does not have.");
  log("");

  /* ── WHAT THE ERP'S GOODS RECEIPT ACTUALLY IS ────────────────────────────
     create-migrated-documents.mjs doGrns() selects `purchase_order_items` with
     received_qty > 0, groups them by PURCHASE ORDER, and writes one grn_item
     per PO line with `qty_received = it.received_qty`. So the ERP's goods
     receipt is a mirror of purchase_order_items.received_qty and nothing else.
     Test 1 proves the mirror is intact; every later test is therefore also a
     statement about received_qty, which is what the outstanding-PO figures and
     the supplier chasing list read. */

  // ───────────────────────── AutoCount side ─────────────────────────
  const acTransferByPo = new Map();     // PoNo -> units AutoCount's PO lines say were transferred
  const acPoHasSofa = new Set();
  const acPoLineCount = new Map();
  for (const r of acPoL) {
    acTransferByPo.set(r.DocNo, (acTransferByPo.get(r.DocNo) ?? 0) + n0(r.TransferedQty));
    acPoLineCount.set(r.DocNo, (acPoLineCount.get(r.DocNo) ?? 0) + 1);
    if (acIsSofa(r.ItemCode)) acPoHasSofa.add(r.DocNo);
  }
  const acGrByPo = new Map();           // PoNo -> units the receipt documents themselves recorded
  const acGrByPoItem = new Map();       // PoNo|ERP code -> units
  for (const r of acGr) {
    acGrByPo.set(r.PoNo, (acGrByPo.get(r.PoNo) ?? 0) + n0(r.GrQtySum));
    const e = erpCodeOf(r.ItemCode);
    const k = `${r.PoNo}|${norm(e ?? r.ItemCode)}`;
    acGrByPoItem.set(k, (acGrByPoItem.get(k) ?? 0) + n0(r.GrQtySum));
  }

  /* THE PRIMARY MEASURE — the live book. */
  const liveTransferByPo = new Map();
  const liveByPoItem = new Map();
  for (const r of edgePoLines) {
    const po = r[eDoc];
    liveTransferByPo.set(po, (liveTransferByPo.get(po) ?? 0) + n0(r[eTrans]));
    const e = erpCodeOf(r[eItem]);
    const k = `${po}|${norm(e ?? r[eItem])}`;
    liveByPoItem.set(k, (liveByPoItem.get(k) ?? 0) + n0(r[eTrans]));
  }

  const allAcPo = new Set([...liveTransferByPo.keys(), ...acTransferByPo.keys(), ...acGrByPo.keys()]);
  let xAgree = 0; const xDiff = [];
  for (const p of allAcPo) {
    if (!acTransferByPo.has(p) && !acGrByPo.has(p)) continue;   // only in the live cut: nothing to cross-check
    const t = r0(acTransferByPo.get(p)), q = r0(acGrByPo.get(p));
    if (t === q) xAgree += 1; else xDiff.push({ po: p, t, q });
  }
  /* How far the book MOVED between the two cuts. This is the number that turned
     the first run's headline into a false alarm, so it is printed before any
     finding rather than discovered afterwards. */
  let moved = 0, movedUnits = 0, shrank = 0;
  for (const [p, live] of liveTransferByPo) {
    if (!acTransferByPo.has(p)) continue;
    const d = r0(live) - r0(acTransferByPo.get(p));
    if (d > 0) { moved += 1; movedUnits += d; } else if (d < 0) shrank += 1;
  }
  log("AUTOCOUNT AGAINST ITSELF — three measures, two vintages");
  log("-".repeat(96));
  log("  (a) same vintage: PODTL.TransferedQty vs SUM(GRDTL.Qty), both from the 2026-08-11 cut.");
  log(`      agree ${pad(xAgree, 6)} of ${xAgree + xDiff.length} purchase orders`);
  log(`      differ${pad(xDiff.length, 6)} — reported UNVERIFIABLE below, never guessed at`);
  for (const d of xDiff.slice(0, TOP)) log(`         ${d.po}  TransferedQty ${d.t}   GRDTL ${d.q}`);
  if (xDiff.length > TOP) log(`         ... and ${xDiff.length - TOP} more`);
  log("");
  log("  (b) different vintage: how far the book MOVED between the two cuts.");
  log(`      purchase orders that received MORE  ${pad(moved, 6)}   (+${movedUnits} unit(s))`);
  log(`      purchase orders that received LESS  ${pad(shrank, 6)}   (AutoCount does not un-receive; a non-zero here means a cut is wrong)`);
  log("      Every one of these would be a false 'invented receipt' if the older cut were used as truth.");
  const ambiguous = new Set(xDiff.map((d) => d.po));
  log("");

  // ───────────────────────────── ERP side ─────────────────────────────
  const erpPo = await sql`
    SELECT p.id, p.po_number, p.linked_ac_docno
      FROM scm.purchase_orders p
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  const erpPoItems = await sql`
    SELECT i.id, i.purchase_order_id, i.item_code, i.item_group, i.qty, i.received_qty,
           p.linked_ac_docno AS ac
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  /* CANCELLED IS EXCLUDED, added 2026-09-07 with the goods-receipt reshape.
     `reshape-migrated-grns.mjs` retires a superseded migrated receipt by
     flipping its status rather than deleting it (the owner's standing rule), so
     from that day a `migrated_no_stock` receipt can be a RETIRED one. Counting
     it would add its units to the live documents that replaced it and report
     the purchase order as over-received. */
  const erpGrn = await sql`
    SELECT g.id, g.grn_number, g.purchase_order_id, g.linked_ac_docno, g.migrated_no_stock
      FROM scm.grns g
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true AND g.status <> 'CANCELLED'`;
  const erpGrnItems = await sql`
    SELECT gi.id, gi.grn_id, gi.purchase_order_item_id, gi.item_code, gi.item_group,
           gi.qty_received, gi.qty_accepted, g.linked_ac_docno AS ac, g.grn_number
      FROM scm.grns g
      JOIN scm.grn_items gi ON gi.grn_id = g.id
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true AND g.status <> 'CANCELLED'`;

  log("SCOPE — the ERP rows this check walks");
  log("-".repeat(96));
  log(`  migrated purchase orders ${pad(erpPo.length, 6)}   lines ${pad(erpPoItems.length, 6)}`);
  log(`  migrated goods receipts  ${pad(erpGrn.length, 6)}   lines ${pad(erpGrnItems.length, 6)}`);
  log("");

  // ── TEST 1 — is the ERP's goods receipt a faithful mirror of its PO line? ──
  /* PER PURCHASE-ORDER LINE, SUMMED OVER ITS RECEIPTS — not per goods-receipt
     line. This compared one line against `received_qty` directly, which was
     right while `create-migrated-documents.mjs` wrote exactly ONE receipt per
     purchase order carrying that column verbatim. Since
     `reshape-migrated-grns.mjs` (owner 2026-09-07: the ERP shows the receipts
     the book actually made), a purchase order received twice has TWO documents
     and neither line equals the column on its own — 70 of 318 purchase orders
     are in that shape, so the old comparison would have reported the split
     itself as a defect on every one of them. The SUM is the statement that
     survived the reshape and it is the one that matters. */
  const poItemById = new Map(erpPoItems.map((r) => [String(r.id), r]));
  const receivedByPoi = new Map();
  const grnsByPoi = new Map();
  let mirrorNoLink = 0;
  for (const gi of erpGrnItems) {
    const key = gi.purchase_order_item_id ? String(gi.purchase_order_item_id) : null;
    if (!key || !poItemById.has(key)) { mirrorNoLink += 1; continue; }
    receivedByPoi.set(key, (receivedByPoi.get(key) ?? 0) + r0(gi.qty_received));
    if (!grnsByPoi.has(key)) grnsByPoi.set(key, []);
    grnsByPoi.get(key).push(gi.grn_number);
  }
  let mirrorOk = 0; const mirrorBad = [];
  for (const [key, qty] of receivedByPoi) {
    const pi = poItemById.get(key);
    if (qty === r0(pi.received_qty)) mirrorOk += 1;
    else mirrorBad.push({ grn: (grnsByPoi.get(key) ?? []).join(" + "), code: pi.item_code, grnQty: qty, poQty: r0(pi.received_qty) });
  }
  log("TEST 1 — do a purchase order line's receipts add up to what the line says it received?");
  log("-".repeat(96));
  log("  A purchase order AutoCount received in more than one go now has one ERP goods receipt per");
  log("  receipt, so no single line equals purchase_order_items.received_qty. What must still hold is");
  log("  the SUM across that line's receipts — the column the outstanding-PO list and supplier chasing read.");
  log(`  agree      ${pad(mirrorOk, 6)} of ${receivedByPoi.size} purchase order lines carrying receipts`);
  log(`  differ     ${pad(mirrorBad.length, 6)}`);
  log(`  no PO line ${pad(mirrorNoLink, 6)}  of ${erpGrnItems.length} goods receipt lines (purchase_order_item_id null or dangling — not comparable)`);
  log("             AutoCount does not record WHICH purchase-order line a receipt line received");
  log("             (GRDTL.FromDocDtlKey is 0 of 21,746 rows), so a line whose item code appears twice");
  log("             on its purchase order is deliberately left unlinked. Owner: 跟 autocount 一样.");
  for (const b of mirrorBad.slice(0, TOP)) log(`     ${b.grn} ${b.code}: receipts add to ${b.grnQty}, PO line says ${b.poQty}`);
  if (mirrorBad.length > TOP) log(`     ... and ${mirrorBad.length - TOP} more`);
  log("");

  // ── TEST 2 — receipts the ERP invented, and receipts it missed ──
  const erpGrnByAcPo = new Map();
  for (const g of erpGrn) if (g.linked_ac_docno) erpGrnByAcPo.set(g.linked_ac_docno, g);
  const erpGrUnitsByPo = new Map();
  const erpGrLinesByPo = new Map();
  const erpGrSofaPo = new Set();
  for (const gi of erpGrnItems) {
    if (!gi.ac) continue;
    erpGrUnitsByPo.set(gi.ac, (erpGrUnitsByPo.get(gi.ac) ?? 0) + n0(gi.qty_received));
    erpGrLinesByPo.set(gi.ac, (erpGrLinesByPo.get(gi.ac) ?? 0) + 1);
    if (String(gi.item_group ?? "").toLowerCase() === "sofa") erpGrSofaPo.add(gi.ac);
  }

  /* THE LIVE CUT DECIDES. The older pair can only ever RAISE the figure, never
     lower it: a receipt it knows about is a receipt, and one it has not seen yet
     is the staleness, not a defect. */
  const inLive = (po) => liveTransferByPo.has(po);
  const acReceived = (po) => Math.max(r0(liveTransferByPo.get(po)), r0(acTransferByPo.get(po)), r0(acGrByPo.get(po)));
  const acNeverReceived = (po) => inLive(po) && acReceived(po) === 0;

  const phantom = [];      // ERP has a receipt, the LIVE book recorded none at all
  const staleOnly = [];    // the older cut says none, the live cut says received — staleness, not a defect
  const notInSnapshot = [];
  for (const [po, g] of erpGrnByAcPo) {
    if (!inLive(po)) { notInSnapshot.push({ po, grn: g.grn_number }); continue; }
    const wouldHaveFlagged = r0(acTransferByPo.get(po)) === 0 && r0(acGrByPo.get(po)) === 0 && acPoLineCount.has(po);
    if (acNeverReceived(po)) phantom.push({ po, grn: g.grn_number, units: r0(erpGrUnitsByPo.get(po)), lines: erpGrLinesByPo.get(po) ?? 0, sofa: erpGrSofaPo.has(po) });
    else if (wouldHaveFlagged) staleOnly.push({ po, grn: g.grn_number, live: r0(liveTransferByPo.get(po)) });
  }
  const missing = [];      // AutoCount received, the ERP holds the PO, but no goods receipt exists
  for (const p of erpPo) {
    const po = p.linked_ac_docno;
    if (erpGrnByAcPo.has(po)) continue;
    if (acReceived(po) > 0) missing.push({ po, erpPo: p.po_number, acUnits: acReceived(po) });
  }

  log("TEST 2 — receipts the ERP has that AutoCount never made, and receipts it is missing");
  log("-".repeat(96));
  log("  Presence against presence. No arithmetic, no code map, no sofa: either AutoCount received");
  log("  something against this purchase order or it did not.");
  log(`  goods receipts INVENTED  ${pad(phantom.length, 6)} of ${erpGrn.length} migrated goods receipts`);
  log("     (AutoCount's PO line says TransferedQty 0 AND no GRDTL row exists for that purchase order)");
  const phantomUnits = phantom.reduce((s, p) => s + p.units, 0);
  const phantomLines = phantom.reduce((s, p) => s + p.lines, 0);
  log(`     they assert ${phantomUnits} unit(s) received across ${phantomLines} line(s)`);
  for (const p of phantom.slice(0, TOP)) log(`     ${p.grn.padEnd(24)} ${p.po}  ${p.lines} line(s) ${p.units} unit(s)${p.sofa ? "  [sofa]" : ""}`);
  if (phantom.length > TOP) log(`     ... and ${phantom.length - TOP} more`);
  log(`  goods receipts MISSING   ${pad(missing.length, 6)} of ${erpPo.length} migrated purchase orders`);
  log("     (AutoCount received against this purchase order; the ERP holds the PO but no goods receipt)");
  for (const m of missing.slice(0, TOP)) log(`     ${m.erpPo.padEnd(24)} ${m.po}  AutoCount received ${m.acUnits} unit(s)`);
  if (missing.length > TOP) log(`     ... and ${missing.length - TOP} more`);
  log(`  STALE, NOT INVENTED      ${pad(staleOnly.length, 6)}  the 2026-08-11 cut shows nothing received and the LIVE book shows a receipt.`);
  log("     The ERP is right and the older snapshot is behind. These are NOT findings and are not counted.");
  for (const s of staleOnly.slice(0, Math.min(5, TOP))) log(`     ${s.grn.padEnd(24)} ${s.po}  live book received ${s.live} unit(s)`);
  if (staleOnly.length > 5) log(`     ... and ${staleOnly.length - 5} more`);
  if (notInSnapshot.length) {
    log(`  NOT IN THE LIVE EXPORT   ${pad(notInSnapshot.length, 6)}  (the purchase order is absent from ac-convert-edges — UNVERIFIABLE)`);
    for (const n of notInSnapshot.slice(0, TOP)) log(`     ${n.grn.padEnd(24)} ${n.po}`);
  }
  log("");

  // ── TEST 3 — quantity, at the purchase order document grain ──
  const cmp = { agree: [], erpMore: [], erpFewer: [], unverifiable: [] };
  for (const [po] of erpGrnByAcPo) {
    if (!inLive(po)) continue;
    const erpU = r0(erpGrUnitsByPo.get(po));
    if (ambiguous.has(po)) { cmp.unverifiable.push({ po, erpU, reason: "AutoCount's two same-vintage measures disagree" }); continue; }
    const acU = acReceived(po);
    const row = { po, erpU, acU, sofa: erpGrSofaPo.has(po) || acPoHasSofa.has(po) };
    if (erpU === acU) cmp.agree.push(row);
    else if (erpU > acU) cmp.erpMore.push(row);
    else cmp.erpFewer.push(row);
  }
  const noSofa = (a) => a.filter((r) => !r.sofa);
  const sofa = (a) => a.filter((r) => r.sofa);
  const cmpTotal = cmp.agree.length + cmp.erpMore.length + cmp.erpFewer.length;
  const cleanTotal = noSofa(cmp.agree).length + noSofa(cmp.erpMore).length + noSofa(cmp.erpFewer).length;

  log("TEST 3 — received QUANTITY, per purchase order");
  log("-".repeat(96));
  log("  Reported in two populations, because they are not equally provable.");
  log("");
  log("  (a) purchase orders with NO sofa line — the ERP and AutoCount have the same row shape here,");
  log("      so the totals are directly comparable and this verdict is exact.");
  log(`      agree      ${pad(noSofa(cmp.agree).length, 6)} of ${cleanTotal}`);
  log(`      ERP MORE   ${pad(noSofa(cmp.erpMore).length, 6)}   the ERP claims more received than AutoCount recorded`);
  log(`      ERP FEWER  ${pad(noSofa(cmp.erpFewer).length, 6)}   the ERP claims less received than AutoCount recorded`);
  for (const r of noSofa(cmp.erpMore).slice(0, TOP)) log(`         MORE  ${r.po}  ERP ${r.erpU}  AutoCount ${r.acU}`);
  for (const r of noSofa(cmp.erpFewer).slice(0, TOP)) log(`         FEWER ${r.po}  ERP ${r.erpU}  AutoCount ${r.acU}`);
  log("");
  log("  (b) purchase orders carrying a sofa line — one AutoCount sofa line becomes one ERP line per");
  log("      COMPARTMENT and the importer copies the same received quantity onto every compartment, so");
  log("      the ERP total is a compartment count, not a receipt count. A difference here is the KNOWN");
  log("      SHAPE DIFFERENCE unless the AutoCount side is zero, which Test 2 already reports.");
  log(`      agree      ${pad(sofa(cmp.agree).length, 6)} of ${cmpTotal - cleanTotal}`);
  log(`      ERP MORE   ${pad(sofa(cmp.erpMore).length, 6)}`);
  log(`      ERP FEWER  ${pad(sofa(cmp.erpFewer).length, 6)}   <- a sofa PO where the ERP received LESS is NOT explained by the shape`);
  for (const r of sofa(cmp.erpFewer).slice(0, TOP)) log(`         FEWER ${r.po}  ERP ${r.erpU}  AutoCount ${r.acU}`);
  log("");
  log(`  UNVERIFIABLE ${pad(cmp.unverifiable.length, 6)}  (AutoCount's own two measures disagree on this purchase order)`);
  for (const r of cmp.unverifiable.slice(0, TOP)) log(`         ${r.po}  ERP ${r.erpU}  ${r.reason}`);
  log("");

  // ── TEST 4 — quantity at (purchase order, item) grain, sofa-free population ──
  const erpByPoItem = new Map();
  for (const gi of erpGrnItems) {
    if (!gi.ac) continue;
    if (String(gi.item_group ?? "").toLowerCase() === "sofa") continue;
    const k = `${gi.ac}|${norm(gi.item_code)}`;
    erpByPoItem.set(k, (erpByPoItem.get(k) ?? 0) + n0(gi.qty_received));
  }
  let itemAgree = 0; const itemDiff = []; let itemNoAc = 0;
  for (const [k, v] of erpByPoItem) {
    const po = k.split("|")[0];
    if (!inLive(po) || ambiguous.has(po) || acNeverReceived(po)) continue;   // already reported by Test 2 / Test 3
    /* Both AutoCount measures again, and the LIVE one wins: the older cut can
       only under-report. */
    const ac = Math.max(r0(liveByPoItem.get(k)), r0(acGrByPoItem.get(k)));
    if (!liveByPoItem.has(k) && !acGrByPoItem.has(k)) { itemNoAc += 1; continue; }
    if (r0(v) === ac) itemAgree += 1;
    else itemDiff.push({ k, erp: r0(v), ac });
  }
  log("TEST 4 — received quantity at (purchase order, item code) grain, sofa lines excluded");
  log("-".repeat(96));
  log("  The finest grain either AutoCount export supports. The AutoCount item code is translated to");
  log("  the ERP code through autocount-erp-mapping-1561.csv, the same map the migration itself used.");
  log("  The live cut's PODTL.TransferedQty per (docNo, itemKey) is the truth; the older GRDTL");
  log("  aggregate can only raise the figure, never lower it.");
  log(`  agree            ${pad(itemAgree, 6)} of ${itemAgree + itemDiff.length} comparable (purchase order, item) pairs`);
  log(`  differ           ${pad(itemDiff.length, 6)}`);
  log(`  no AutoCount row ${pad(itemNoAc, 6)}  (the code did not translate, or AutoCount received a different code — UNVERIFIABLE)`);
  for (const d of itemDiff.slice(0, TOP)) log(`     ${d.k}  ERP ${d.erp}  AutoCount ${d.ac}`);
  if (itemDiff.length > TOP) log(`     ... and ${itemDiff.length - TOP} more`);
  log("");

  // ───────────────────────────── VERDICT ─────────────────────────────
  log("=".repeat(96));
  const bad = phantom.length + missing.length + mirrorBad.length + noSofa(cmp.erpMore).length
    + noSofa(cmp.erpFewer).length + sofa(cmp.erpFewer).length + itemDiff.length;
  if (bad === 0) {
    log("ANSWER: YES — on every axis the AutoCount export can support, the ERP's goods receipts match");
    log(`the book. ${erpGrn.length} goods receipts, ${erpGrnItems.length} lines.`);
  } else {
    log(`ANSWER: NO — ${bad} goods-receipt finding(s) against AutoCount, over ${erpGrn.length} migrated goods receipts`);
    log(`(${erpGrnItems.length} lines) and ${erpPo.length} migrated purchase orders.`);
    log(`  invented receipts ${phantom.length}, missing receipts ${missing.length}, broken mirror ${mirrorBad.length},`);
    log(`  sofa-free quantity ${noSofa(cmp.erpMore).length + noSofa(cmp.erpFewer).length}, sofa short ${sofa(cmp.erpFewer).length}, item-grain ${itemDiff.length}.`);
  }
  log(`UNVERIFIABLE, stated rather than hidden: ${cmp.unverifiable.length} purchase order(s) where AutoCount's own`);
  log(`two same-vintage measures disagree, ${itemNoAc} (purchase order, item) pair(s) with no AutoCount counterpart,`);
  log(`${mirrorNoLink} goods receipt line(s) with no purchase order line, ${notInSnapshot.length} purchase order(s) absent from the live export.`);
  log(`NOT counted as findings: ${staleOnly.length} goods receipt(s) the 2026-08-11 cut would have called invented and the`);
  log("live book confirms. That gap is the reason this check reads the live export first.");
  log("Read-only check. Repairing anything found here is a separate, owner-approved change.");
  log(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

main().then(() => sql.end({ timeout: 5 })).catch(async (e) => {
  console.error(e);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
