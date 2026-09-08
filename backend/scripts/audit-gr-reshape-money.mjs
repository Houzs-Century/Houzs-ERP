#!/usr/bin/env node
/* audit-gr-reshape-money — settle the goods-receipt reshape's money question
 * against the ACCOUNT BOOK, offline.
 *
 * WHY THIS EXISTS.  `reshape-migrated-grns.mjs` printed one line — "the migrated
 * receipts hold RM 210,513.43 today; this plan writes RM 461,371.95" — and that
 * unexplained 119% blocked the cutover three times (docs/bugs/0682).  A delta
 * between two states of OUR OWN system cannot tell a price correction from a
 * double-count.  Only the book can, and this derives the book's figure.
 *
 * NO DATABASE, NO NETWORK, NO node_modules.  Pure functions over the committed
 * extracts plus `lib/ac-scope.mjs`, so anyone can re-derive the ceiling on a bare
 * checkout instead of trusting a sentence.
 *
 *   node backend/scripts/audit-gr-reshape-money.mjs
 *   DUMP=<path to migrated-grns-*.json> node backend/scripts/audit-gr-reshape-money.mjs
 *
 * The optional DUMP is the reshape's OWN pre-write artifact
 * (`migrated-grns-before-prod`, written in plan mode too).  With it, the ERP side
 * is decomposed the same way the writer classifies it, so the headline
 * before/after can be taken apart without touching production.
 *
 * THE TWO TESTS THAT SETTLE IT.
 *   PARTITION  every in-scope GRDTL row carries its own FromDocNo, so it belongs
 *              to exactly one (receipt x purchase order) pair.  If a key appeared
 *              in two pairs the reshape would multiply it — that is the
 *              `linked_ac_dtlkey` shape that nearly wrote RM 2,216,501 of
 *              invented revenue on 2026-09-07.
 *   CEILING    AutoCount's own GRDTL SubTotal for those pairs.  A plan landing
 *              UNDER it cannot be double-counting; one landing OVER it is not to
 *              be applied.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScope, decodeSnapshot, currencyVerdict } from "./lib/ac-scope.mjs";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString("utf8").replace(/^﻿/, ""));
const rm = (s) => `RM ${(s / 100).toFixed(2)}`;
const n0 = (v) => Number(v || 0);

const snap = gz("ac-reconcile-truth.json.gz");
const book = decodeSnapshot(snap);
const scope = buildScope(book);
const ce = gz("ac-convert-edges.json.gz");

/* The pairs, built exactly as reshape-migrated-grns.mjs builds them.  The rows
   are ARRAYS, positional per line_fields/header_fields — reading them as objects
   returns undefined, which an agent already mistook for evidence (docs/bugs/0674). */
const LF = ce.line_fields, HF = ce.header_fields;
const iDoc = LF.indexOf("docNo"), iKey = LF.indexOf("dtlKey"), iItem = LF.indexOf("itemKey");
const iQty = LF.indexOf("qty"), iFT = LF.indexOf("fromDocType"), iFN = LF.indexOf("fromDocNo");
const hDoc = HF.indexOf("docNo"), hCanc = HF.indexOf("cancelled");
if ([iDoc, iKey, iItem, iQty, iFT, iFN, hDoc, hCanc].some((i) => i < 0)) {
  throw new Error("ac-convert-edges.json.gz does not carry the fields this audit reads");
}
const cancelled = new Map(ce.types.GR.headers.map((h) => [String(h[hDoc]).trim(), String(h[hCanc] ?? "").trim() !== "F"]));
const pairs = new Map();
for (const r of ce.types.GR.lines) {
  const gr = String(r[iDoc] ?? "").trim();
  if (!scope.GR.has(gr) || String(r[iFT] ?? "").trim() !== "PO") continue;
  const po = String(r[iFN] ?? "").trim();
  if (!scope.PO.has(po) || cancelled.get(gr) !== false) continue;
  const k = `${gr}|${po}`;
  if (!pairs.has(k)) pairs.set(k, { gr, po, lines: [] });
  pairs.get(k).lines.push({ dtlKey: String(r[iKey] ?? "").trim(), itemKey: String(r[iItem] ?? "").trim(), qty: n0(r[iQty]) });
}

console.log(`snapshot ${snap.exported_at}   edges ${ce.exported_at}`);
console.log(`in scope: ${scope.GR.size} goods receipts, ${scope.PO.size} purchase orders`);
console.log(`BOOK pairs: ${pairs.size} over ${new Set([...pairs.values()].map((p) => p.po)).size} purchase orders`);

/* ── TEST 1: is the split a strict partition? ─────────────────────────────── */
const seen = new Map();
let lines = 0, units = 0;
for (const p of pairs.values()) {
  for (const l of p.lines) {
    lines += 1;
    units += l.qty;
    seen.set(l.dtlKey, (seen.get(l.dtlKey) ?? 0) + 1);
  }
}
const dup = [...seen].filter(([, c]) => c > 1);
console.log(`\n═══ TEST 1 — PARTITION ═══`);
console.log(`  in-scope receipt lines ${lines}, units ${units}`);
console.log(`  receipt-line keys landing on MORE THAN ONE pair: ${dup.length}` +
  (dup.length
    ? `  *** ${dup.slice(0, 10).map(([k, c]) => `${k} x${c}`).join(", ")} — THE RESHAPE WOULD MULTIPLY THESE ***`
    : `  -> a strict partition; the reshape cannot multiply a line.`));

/* ── TEST 2: the book's own money for those very lines ────────────────────── */
let localSen = 0, qtyXprice = 0, missing = 0, zeroPriced = 0;
for (const p of pairs.values()) {
  for (const l of p.lines) {
    const bl = book.GR.byDtlKey.get(l.dtlKey) ?? book.GR.byDtlKey.get(Number(l.dtlKey));
    if (!bl) { missing += 1; continue; }
    localSen += bl.subTotalSen ?? 0;
    qtyXprice += Math.round(n0(bl.qty) * n0(bl.unitPriceSen));
    if (!(bl.unitPriceSen > 0)) zeroPriced += 1;
  }
}
const ccy = new Map();
for (const gr of new Set([...pairs.values()].map((p) => p.gr))) {
  const k = currencyVerdict(book.GR.headers.get(gr)).kind;
  ccy.set(k, (ccy.get(k) ?? 0) + 1);
}
console.log(`\n═══ TEST 2 — THE CEILING ═══`);
console.log(`  receipt lines absent from the reconcile snapshot: ${missing} of ${lines}`);
console.log(`  receipt lines the BOOK ITSELF prices at zero:     ${zeroPriced} of ${lines}`);
console.log(`  currency of the in-scope receipts: ${[...ccy].map(([k, c]) => `${k} ${c}`).join(", ")}` +
  (ccy.get("foreign") ? "   *** a foreign document makes a total ambiguous — see currencyVerdict ***" : "   (no FX ambiguity)"));
console.log(`  sum(GRDTL SubTotal)          = ${rm(localSen)}   <- THE CEILING`);
console.log(`  sum(qty x GRDTL UnitPrice)   = ${rm(qtyXprice)}`);

/* ── the ERP side, from the reshape's own pre-write dump ──────────────────── */
if (!process.env.DUMP) {
  console.log(`\n(no DUMP given — pass the reshape's migrated-grns-*.json artifact to decompose the ERP side)`);
  process.exit(0);
}
const dump = JSON.parse(fs.readFileSync(process.env.DUMP, "utf8"));
const byGrn = new Map();
for (const l of dump.grn_items) {
  if (!byGrn.has(l.grn_id)) byGrn.set(l.grn_id, []);
  byGrn.get(l.grn_id).push(l);
}
const lt = (g) => (byGrn.get(g.id) ?? []).reduce((t, l) => t + n0(l.line_total_sen), 0);
const qp = (g) => (byGrn.get(g.id) ?? []).reduce((t, l) => t + Math.round(n0(l.qty_accepted) * n0(l.unit_price_sen)), 0);
const uq = (g) => (byGrn.get(g.id) ?? []).reduce((t, l) => t + n0(l.qty_accepted), 0);
const sum = (a, f) => a.reduce((t, g) => t + f(g), 0);
const bookPos = new Set([...pairs.values()].map((p) => p.po));
const took = new Set();
const replaced = [], unpaired = [];
for (const g of dump.grns) {
  const acGr = (g.ac_grs ?? []).map((x) => String(x).trim())
    .find((x) => g.grn_number === `HC-${x}` || g.grn_number.startsWith(`HC-${x}-`)) ?? null;
  g._poAc = String(g.po_ac ?? "").trim();
  const k = acGr ? `${acGr}|${g._poAc}` : null;
  if (k && pairs.has(k) && !took.has(k)) { took.add(k); replaced.push(g); } else unpaired.push(g);
}
const retire = unpaired.filter((g) => bookPos.has(g._poAc));
const untouched = unpaired.filter((g) => !bookPos.has(g._poAc));
const priced0 = dump.grn_items.filter((l) => n0(l.line_total_sen) === 0 && n0(l.unit_price_sen) > 0);
console.log(`\n═══ THE ERP SIDE — dump taken ${dump.taken_at} ═══`);
console.log(`  ${dump.grns.length} migrated documents, ${dump.grn_items.length} lines, ${sum(dump.grns, uq)} units`);
console.log(`  sum(line_total_sen) over ALL of them        ${rm(sum(dump.grns, lt))}   <- the old headline "before"`);
console.log(`    ${String(replaced.length).padStart(3)} REPLACED by the plan     line_total ${rm(sum(replaced, lt))}   qty x price ${rm(sum(replaced, qp))}`);
console.log(`    ${String(retire.length).padStart(3)} CANCELLED as superseded  line_total ${rm(sum(retire, lt))}`);
console.log(`    ${String(untouched.length).padStart(3)} UNTOUCHED and SURVIVING  line_total ${rm(sum(untouched, lt))}   <- in the "before", absent from the "after"`);
console.log(`  lines holding a PRICE but a ZERO line_total_sen: ${priced0.length} of ${dump.grn_items.length}`);
console.log(`    -> that column, not the reshape, is why the "before" reads low.`);
console.log(`\n  LIKE FOR LIKE: the ${replaced.length} documents the plan replaces are worth ${rm(sum(replaced, qp))} today,`);
console.log(`  against a book ceiling of ${rm(localSen)} for the ${pairs.size} pairs that replace them.`);
