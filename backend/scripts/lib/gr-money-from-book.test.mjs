/* The cases are the REAL ones, taken from the committed account-book cut and
 * from the reconcile run that reported them, so a change to the rule fails
 * against a document somebody can go and look at rather than against a fixture
 * somebody invented.
 *
 * Run: node --test backend/scripts/lib/gr-money-from-book.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { planReceiptMoney } from "./gr-money-from-book.mjs";
import { decodeSnapshot } from "./ac-scope.mjs";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const snap = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(DATA, "ac-reconcile-truth.json.gz"))).toString("utf8").replace(/^﻿/, ""),
);
const book = decodeSnapshot(snap);
const bookLine = (k) => book.GR.byDtlKey.get(k) ?? book.GR.byDtlKey.get(Number(k));

/** The book's own GRDTL rows of one receipt, as ERP lines that hold the WRONG
 *  money — `qty x UnitPrice` with the discount dropped, which is exactly what
 *  reshape-migrated-grns.mjs wrote. */
const erpAsImported = (acGr, fromDocNo) =>
  [...book.GR.byDtlKey.values()]
    .filter((l) => String(l.docNo).trim() === acGr && (!fromDocNo || String(l.fromDocNo ?? "").trim() === fromDocNo))
    .map((l, n) => ({
      id: `row-${n}`, itemCode: l.itemKey, acDtlKey: String(l.dtlKey),
      unitPriceSen: Math.round(Number(l.unitPriceSen || 0)),
      discountSen: 0,
      lineTotalSen: Math.round(Number(l.qty || 0) * Number(l.unitPriceSen || 0)),
    }));

const hdr = (acGr, totalSen, over = {}) => ({
  acGr, currency: "MYR", subtotalSen: totalSen, totalSen,
  migratedNoStock: true, movements: 0, ...over,
});

/* ── THE FIELD-NAME GUARD ───────────────────────────────────────────────────
   A field name that does not exist reads as undefined and arithmetic on it
   reads as ZERO everywhere, which once produced the confident sentence "18,890
   of 18,890 order lines have no price". The decoded snapshot exposes
   `unitPriceSen` / `subTotalSen`, NOT `unitPrice` / `subTotal`. If that ever
   changes, every assertion below would still pass with every figure at zero —
   so the names are asserted before any of them run. */
test("the decoded snapshot really exposes the money fields this module reads", () => {
  const l = bookLine("926907");
  assert.ok(l, "GR-005363 line 926907 is in the committed cut");
  assert.equal(typeof l.unitPriceSen, "number");
  assert.equal(typeof l.subTotalSen, "number");
  assert.ok(l.unitPriceSen > 0 && l.subTotalSen > 0, `both must be non-zero, got ${l.unitPriceSen}/${l.subTotalSen}`);
  assert.equal(l.subTotalSen, 78750, "the book prices this AKEMI mattress at RM 787.50 after its own 25%");
  assert.equal(l.unitPriceSen, 105000, "off a list price of RM 1,050.00");
});

/* ── THE THREE THE OWNER RULED ON ───────────────────────────────────────────
   Run 34300012504 reported all three as `document total`, each exactly the
   book x 4/3 — AutoCount took 25% off and we did not. 「autocount怎么写我们就
   怎么写」. */
for (const [acGr, bookSen, erpSen] of [
  ["GR-005363", 352500, 470000],
  ["GR-005367", 157500, 210000],
  ["GR-005368", 125850, 167800],
]) {
  test(`${acGr}: the book's own SubTotal is taken, and the ERP's x 4/3 is not`, () => {
    const items = erpAsImported(acGr);
    assert.ok(items.length, `${acGr} has lines in the committed cut`);
    const got = planReceiptMoney({ header: hdr(acGr, erpSen), items, bookLine, localCurrency: true });
    assert.equal(got.verdict, "write", got.why);
    assert.equal(got.wantTotal, bookSen, "the target is the book's SubTotal, to the sen");
    assert.equal(got.deltaSen, bookSen - erpSen);
    /* The shape that proves it is a COPY and not a recomputation: the ERP's
       figure is exactly four thirds of the book's, and the discount written is
       the gap the book itself states. */
    assert.equal(erpSen * 3, bookSen * 4, "these three are the book x 4/3 by construction");
    for (const r of got.rows) {
      const bl = bookLine(String(r.item.acDtlKey));
      assert.equal(r.total, Math.round(bl.subTotalSen), "line total is the book's SubTotal verbatim");
      assert.equal(r.unit, Math.round(bl.unitPriceSen), "unit price is the book's UnitPrice verbatim");
      assert.equal(r.disc, Math.max(0, Math.round(bl.qty * bl.unitPriceSen) - Math.round(bl.subTotalSen)));
    }
    assert.ok(got.rows.some((r) => r.disc > 0), "at least one line carries the discount the book states");
  });
}

/* ── IDEMPOTENCE, WHICH IS THE RE-RUN CONTRACT ─────────────────────────────── */
test("a receipt already holding the book's money plans nothing", () => {
  const acGr = "GR-005363";
  const items = [...book.GR.byDtlKey.values()]
    .filter((l) => String(l.docNo).trim() === acGr)
    .map((l, n) => ({
      id: `row-${n}`, itemCode: l.itemKey, acDtlKey: String(l.dtlKey),
      unitPriceSen: Math.round(l.unitPriceSen), lineTotalSen: Math.round(l.subTotalSen),
      discountSen: Math.max(0, Math.round(l.qty * l.unitPriceSen) - Math.round(l.subTotalSen)),
    }));
  const got = planReceiptMoney({ header: hdr(acGr, 352500), items, bookLine, localCurrency: true });
  assert.equal(got.verdict, "agree", got.why);
});

/* ── EVERY REFUSAL IS A VERDICT, NOT AN EXCEPTION ──────────────────────────── */
test("a receipt whose stock really moved is REFUSED and still reports the ringgit", () => {
  const acGr = "GR-005363";
  const got = planReceiptMoney({
    header: hdr(acGr, 470000, { movements: 4 }),
    items: erpAsImported(acGr), bookLine, localCurrency: true,
  });
  assert.equal(got.verdict, "moved-stock");
  assert.match(got.why, /4 inventory movement/);
  assert.equal(got.wantTotal, 352500, "the figure is named even though nothing is written");
  assert.equal(got.deltaSen, -117500);
});

test("a receipt that is not migrated paperwork is REFUSED", () => {
  const got = planReceiptMoney({
    header: hdr("GR-005363", 470000, { migratedNoStock: false }),
    items: erpAsImported("GR-005363"), bookLine, localCurrency: true,
  });
  assert.equal(got.verdict, "moved-stock");
  assert.match(got.why, /not migrated paperwork/);
});

test("one keyless line refuses the WHOLE receipt, never half of it", () => {
  const items = erpAsImported("GR-005363");
  items[0].acDtlKey = null;
  const got = planReceiptMoney({ header: hdr("GR-005363", 470000), items, bookLine, localCurrency: true });
  assert.equal(got.verdict, "keyless");
  assert.equal(got.rows.length, 0, "nothing is planned for the lines that DO carry a key");
});

test("a line key naming another document is REFUSED, never matched by text instead", () => {
  const items = erpAsImported("GR-005363");
  items[0].acDtlKey = "926942"; // a real key — but it is GR-005367's line
  const got = planReceiptMoney({ header: hdr("GR-005363", 470000), items, bookLine, localCurrency: true });
  assert.equal(got.verdict, "foreign-key");
  assert.match(got.why, /926942/);
});

test("a foreign-currency receipt is REFUSED, because a rate is not a discount", () => {
  const got = planReceiptMoney({
    header: hdr("GR-005363", 470000, { currency: "CNY" }),
    items: erpAsImported("GR-005363"), bookLine, localCurrency: false,
  });
  assert.equal(got.verdict, "foreign-currency");
});

/* ── THE RM 55 ONE ──────────────────────────────────────────────────────────
   HC-GR-005326-PO-009953: the run reports AutoCount RM 1,055.00 against our
   RM 1,000.00 and nobody knows why we are RM 55.00 short. The owner: copy the
   book anyway, do not chase the cause first. What is pinned here is that the
   book's own figure for that PAIR really is 1,055.00, so the target is a
   reading and not a guess. */
test("GR-005326 x PO-009953: the book's own pair total is RM 1,055.00", () => {
  const lines = [...book.GR.byDtlKey.values()]
    .filter((l) => String(l.docNo).trim() === "GR-005326" && String(l.fromDocNo ?? "").trim() === "PO-009953");
  assert.equal(lines.length, 2, "two lines of GR-005326 were raised from PO-009953");
  assert.equal(lines.reduce((s, l) => s + Math.round(l.subTotalSen), 0), 105500);
  /* And these two carry no discount at all — the RM 55.00 is NOT a dropped
     discount, which is what tells this one apart from the three above. */
  for (const l of lines) assert.equal(Math.round(l.qty * l.unitPriceSen), Math.round(l.subTotalSen));
});

/* ── ONE SOFA IS ONE BOOK LINE AND N ERP ROWS ───────────────────────────────
 * The first version of this module gave every row sharing a line key that
 * line's whole SubTotal. The production plan run 34302355074 printed the
 * consequence on the first document it reached — `HC-GR-000815 RM 2,867.43 ->
 * RM 8,602.29`, one sofa's price three times — across 105 receipts and
 * RM 199,232.36 of money that does not exist in the book. Nothing was written;
 * the plan is what caught it. This is that document's shape, so the defect
 * cannot come back quietly.
 *
 * The book's OWN figure is the fixture: GR-000815 line 209355 is read out of
 * the committed cut rather than typed, so if the book changes the test changes
 * with it. */
test("three compartment rows of ONE sofa take the book's price ONCE, on the lead", () => {
  const bl = bookLine("209355");
  assert.ok(bl, "GR-000815 line 209355 is in the committed cut");
  assert.equal(Math.round(bl.subTotalSen), 286743, "the book prices that sofa at RM 2,867.43");

  /* Three ERP compartment rows, all carrying that one book line's key — the
     shape mig 0273/0280 creates and the shape prod actually holds. */
  const items = ["5527-Console", "5527-1A(LHF)", "5527-1A(RHF)"].map((code, n) => ({
    id: `row-${n}`, itemCode: code, acDtlKey: "209355",
    unitPriceSen: 0, discountSen: 0, lineTotalSen: 0,
  }));
  const got = planReceiptMoney({
    header: hdr("GR-000815", 286743), items, bookLine, localCurrency: true,
  });

  assert.equal(got.wantTotal, 286743,
    "the DOCUMENT total counts the book LINE once — three times over is RM 8,602.29, which is the bug");
  assert.equal(got.rows.length, 3, "every row is still planned, so none is left stale");
  const [lead, ...rest] = got.rows;
  assert.equal(lead.total, 286743, "the price rides the LEAD piece");
  assert.equal(lead.unit, Math.round(bl.unitPriceSen));
  for (const r of rest) {
    assert.equal(r.total, 0, "every other compartment is zero in both columns");
    assert.equal(r.unit, 0);
    assert.equal(r.disc, 0);
  }
  assert.equal(got.rows.reduce((s, r) => s + r.total, 0), got.wantTotal,
    "the lines still sum to the header, which is what the apply's own verify asserts");
});

test("a receipt whose sofa already carries the book's money on its lead plans nothing", () => {
  const bl = bookLine("209355");
  const items = ["5527-Console", "5527-1A(LHF)", "5527-1A(RHF)"].map((code, n) => ({
    id: `row-${n}`, itemCode: code, acDtlKey: "209355",
    unitPriceSen: n === 0 ? Math.round(bl.unitPriceSen) : 0,
    lineTotalSen: n === 0 ? Math.round(bl.subTotalSen) : 0,
    discountSen: n === 0 ? Math.max(0, Math.round(bl.qty * bl.unitPriceSen) - Math.round(bl.subTotalSen)) : 0,
  }));
  const got = planReceiptMoney({ header: hdr("GR-000815", 286743), items, bookLine, localCurrency: true });
  assert.equal(got.verdict, "agree", got.why);
});
