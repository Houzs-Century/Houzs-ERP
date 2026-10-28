// Proof that reading the ACTUAL purchase invoice beats inferring a price, and
// that the refusal rules hold.
//
// Every fixture below is a REAL record read from live AutoCount on 2026-08-11
// (see backend/scripts/data/ac-invoice-prices.json.gz). NB-NH39(A)(K) is one
// item code that was genuinely purchased at four different prices on four
// different purchase orders — each price sitting on a named purchase invoice a
// human can open:
//
//   PO-008733  RM1760.00  PI-006959 via GR-004631
//   PO-000926  RM1680.00  PI-001307 via GR-000656
//   PO-000278  RM1500.00  PI-000875 via GR-000230
//   PO-003645  RM1180.00  PI-003160 via GR-001999
//
// Inference by item code cannot be right about more than one of them. Across
// the whole extract, 318 item codes have a price that varies by PO, and
// MAX-by-item-code inference overstates 10,513 purchase lines. That is the
// number this lane removes.
import { test } from 'vitest';
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAcToErp, buildPriceIndex, resolvePrice, planWrite,
  buildGrPriceIndex, measureLayerCostability,
} from "../scripts/lib/invoice-price-core.mjs";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "data");
const gz = (f) => JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString("utf8").replace(/^﻿/, ""));

const MAP = [
  { ac_code: "NB-NH39(A)(K)", erp_code: "NH39-A-(K)" },
  { ac_code: "NB-KHJ21(Q)", erp_code: "VICTORIA-(Q)" },
  { ac_code: "HOK-1041 (Q)", erp_code: "VICTORIA-(Q)" },
];
const acToErp = buildAcToErp(MAP);

const row = (poNo, acItem, price, piNo, grNo, desc2 = "", status = "RESOLVED") => ({
  poNo, acItem, desc2, status,
  obs: price == null ? [] : [{ price, piNo, piDate: "2026-01-01", grNo }],
  distinctPrices: price == null ? [] : [price],
});

const NH39 = [
  row("PO-008733", "NB-NH39(A)(K)", 1760, "PI-006959", "GR-004631"),
  row("PO-000926", "NB-NH39(A)(K)", 1680, "PI-001307", "GR-000656"),
  row("PO-000278", "NB-NH39(A)(K)", 1500, "PI-000875", "GR-000230"),
  row("PO-003645", "NB-NH39(A)(K)", 1180, "PI-003160", "GR-001999"),
];

/** The approach this lane REPLACES: one cost per item code, taken as the max.
 *  Mirrors backfill-zero-cost-lots.mjs:60-66 ("take the HIGHEST ... rather than
 *  whichever came first"). */
function inferMaxByItemCode(rows) {
  const best = new Map();
  for (const r of rows) {
    for (const o of r.obs) {
      const k = r.acItem.toUpperCase();
      if (!best.has(k) || o.price > best.get(k)) best.set(k, o.price);
    }
  }
  return best;
}

test("the invoice gives each PO its OWN price; inference cannot", () => {
  const idx = buildPriceIndex(NH39, acToErp);
  const expected = { "PO-008733": 176000, "PO-000926": 168000, "PO-000278": 150000, "PO-003645": 118000 };
  for (const [poNo, centi] of Object.entries(expected)) {
    const r = resolvePrice(idx, poNo, "NH39-A-(K)");
    assert.equal(r.status, "RESOLVED", `${poNo} must resolve`);
    assert.equal(r.priceSen, centi, `${poNo} must take ITS OWN invoice price`);
  }
  // provenance is mandatory — a price with no invoice behind it is unauditable
  assert.equal(resolvePrice(idx, "PO-000278", "NH39-A-(K)").piNo, "PI-000875");
  assert.equal(resolvePrice(idx, "PO-003645", "NH39-A-(K)").piNo, "PI-003160");

  // and the same fixtures under inference: one price for all four POs
  const inferred = inferMaxByItemCode(NH39);
  const flat = Math.round(inferred.get("NB-NH39(A)(K)") * 100);
  assert.equal(flat, 176000);
  const wrong = Object.entries(expected).filter(([, c]) => c !== flat);
  assert.equal(wrong.length, 3, "inference is wrong on 3 of these 4 real lines");
  // the worst single overstatement here is RM1760 - RM1180 = RM580 per unit
  assert.equal(flat - Math.min(...Object.values(expected)), 58000);
});

test("AMBIGUOUS is refused, never guessed", () => {
  // One AutoCount PO, one ERP code, two DIFFERENT invoice prices.
  const idx = buildPriceIndex([
    row("PO-000125", "NB-NH39(A)(K)", 692, "PI-000600", "GR-000300"),
    row("PO-000125", "NB-NH39(A)(K)", 1725.6, "PI-000601", "GR-000301"),
  ], acToErp);
  const r = resolvePrice(idx, "PO-000125", "NH39-A-(K)");
  assert.equal(r.status, "AMBIGUOUS");
  assert.deepEqual(r.prices, [69200, 172560]);
  const p = planWrite(0, r);
  assert.equal(p.action, "SKIP");
  assert.equal(p.reason, "SKIP_AMBIGUOUS");
  assert.equal(p.priceSen, undefined, "an ambiguous key must carry NO value");
});

test("the many-to-one item map can only ADD ambiguity, never invent agreement", () => {
  // NB-KHJ21(Q) and HOK-1041 (Q) are both ERP VICTORIA-(Q) — different
  // suppliers, different prices. Collapsing them must refuse, not pick one.
  const idx = buildPriceIndex([
    row("PO-001000", "NB-KHJ21(Q)", 800, "PI-002000", "GR-001000"),
    row("PO-001000", "HOK-1041 (Q)", 950, "PI-002001", "GR-001001"),
  ], acToErp);
  const r = resolvePrice(idx, "PO-001000", "VICTORIA-(Q)");
  assert.equal(r.status, "AMBIGUOUS");
  assert.equal(planWrite(0, r).action, "SKIP");
});

test("a hand-entered price is never overwritten, and writes are idempotent", () => {
  const idx = buildPriceIndex(NH39, acToErp);
  const r = resolvePrice(idx, "PO-000278", "NH39-A-(K)");
  assert.equal(r.status, "RESOLVED");
  // blank -> writes
  assert.equal(planWrite(0, r).action, "WRITE");
  assert.equal(planWrite(null, r).action, "WRITE");
  // already priced -> never touched, whatever the invoice says
  for (const cur of [1, 99999, 150000, 1]) {
    const p = planWrite(cur, r);
    assert.equal(p.action, "SKIP");
    assert.equal(p.reason, "SKIP_ALREADY_PRICED");
  }
  // idempotency: after the write lands, the same plan is a no-op
  assert.equal(planWrite(r.priceSen, r).reason, "SKIP_ALREADY_PRICED");
});

test("a zero-priced invoice line is not a price", () => {
  const idx = buildPriceIndex([row("PO-002000", "NB-NH39(A)(K)", 0, "PI-003000", "GR-002000")], acToErp);
  const r = resolvePrice(idx, "PO-002000", "NH39-A-(K)");
  assert.equal(r.status, "NO_INVOICE_PRICE");
  assert.equal(planWrite(0, r).action, "SKIP");
  assert.equal(planWrite(0, r).reason, "SKIP_NO_INVOICE_PRICE");
});

test("an unmapped AutoCount item never reaches an ERP line", () => {
  const idx = buildPriceIndex([row("PO-004000", "SOME-UNMAPPED-CODE", 500, "PI-004000", "GR-004000")], acToErp);
  assert.equal(resolvePrice(idx, "PO-004000", "SOME-UNMAPPED-CODE").status, "NO_INVOICE_PRICE");
});

test("document numbers match across formatting differences", () => {
  const idx = buildPriceIndex([row("PO 000255", "NB-NH39(A)(K)", 640, "PI-000900", "GR-000500")], acToErp);
  // ac-gr-refs.json.gz writes "PO 000255"; PODTL writes "PO-000255".
  assert.equal(resolvePrice(idx, "PO-000255", "NH39-A-(K)").priceSen, 64000);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REFUSAL, PINNED AGAINST THE REAL DATA
// ─────────────────────────────────────────────────────────────────────────────
// This lane deliberately does NOT cost the zero-cost cutover stock layers. That
// is a measurement, not an opinion, and this test is the measurement — run over
// the two committed extracts so anyone can reproduce it without a database or a
// ZeroTier route to AutoCount. If a future change makes the invoice able to cost
// those layers, this test fails and the refusal must be revisited on purpose.
test("the zero-cost cutover layers cannot be costed from their own invoice", () => {
  const priceRows = gz("ac-invoice-prices.json.gz").rows;
  // Same filter import-ac-stock-layers.mjs applies: whole-sofa balances were
  // deliberately never imported, so sofa layers are not part of this population.
  const layers = gz("ac-stock-layers.json.gz").filter((l) => !/SOFA/i.test(l.ItemCode || ""));
  const m = measureLayerCostability(layers, buildGrPriceIndex(priceRows));

  assert.equal(m.total, 315, "zero-cost cutover layers in the source data");
  assert.equal(m.units, 1068, "units sitting on those layers");
  /* RE-PINNED 2026-08-28 against the refreshed price extract, and the change
     is the EVENT this test was built to catch, revisited on purpose: when the
     extract was cut on 8-11 only 3 layers resolved to a real invoice price
     (289 uninvoiced + 23 uncovered = 312 of 315 had no truthful number). The
     book then received the suppliers' August invoices (PI-0078xx), so 61
     layers now resolve — including the original three, still asserted below.
     The refusal stands for the 216+23 that remain unpriced; the 61 resolved
     are the population a deliberate costing pass may now write, from each
     layer's OWN invoice, no borrowing. */
  assert.equal(m.noInvoicePrice, 216, "their own receipt's invoice ALSO says 0.00");
  assert.equal(m.noSourceDoc, 23, "layer has no receipt at all (Src=UNCOVERED)");
  assert.equal(m.ambiguous, 15, "several invoices for the receipt disagree — not guessed");
  assert.equal(m.resolved.length, 61, "layers resolving to a real invoice price");

  // The original three provenance rows must survive any re-cut — a human can
  // still open those invoices and check.
  const keys = m.resolved.map((r) => `${r.grNo} ${r.piNo} ${r.centi}`);
  for (const k of ["GR-000368 PI-001040 101900", "GR-002122 PI-003419 323900", "GR-003937 PI-006240 28000"]) {
    assert.ok(keys.includes(k), `provenance row lost: ${k}`);
  }

  // 216 + 23 = 239 of 315 still have NO truthful number anywhere on the
  // invoice chain. Costing them would mean borrowing a price off a DIFFERENT
  // document, which is the inference this lane exists to remove.
  assert.equal(m.noInvoicePrice + m.noSourceDoc, 239);
});
