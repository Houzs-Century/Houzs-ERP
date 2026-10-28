/**
 * The transfer-counter classifier, exercised on the same function
 * check-ac-transfer-counters.mjs calls.
 *
 * NO SHEBANG — a test-imported module must not carry one (CLAUDE.md).
 *
 * Every case below pins something this lane would otherwise get wrong. The one
 * that matters most is the DECOMPOSED PARTIAL: a sofa is one AutoCount line and
 * six ERP compartment rows, so a comparison that subtracts instead of comparing
 * fractions reports every sofa in the book as a defect. That reading is what
 * "40 disagreements" would have become.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { verdictFor, isOneToOne, tally, selfTestCases, runSelfTest } from "../scripts/lib/transfer-counter-verdict.mjs";

test("the built-in self-test passes, so the checker is allowed to run", () => {
  assert.deepEqual(runSelfTest(), []);
});

test("every planted case lands on its own verdict and nothing else", () => {
  for (const c of selfTestCases()) {
    assert.equal(verdictFor(c.g), c.want, c.name);
  }
});

test("a decomposed line that agrees exactly is SILENT, not a defect", () => {
  // One book sofa line, quantity 1, fully received. Six ERP compartment rows,
  // quantity 1 each, all received. 1/1 === 6/6.
  const sofa = { bookQty: 10000, bookTransfered: 10000, erpQty: 60000, erpCounter: 60000, rows: 6 };
  assert.equal(verdictFor(sofa), "agree");
  // And the naive subtraction this replaces would have called it a defect.
  assert.notEqual(sofa.bookTransfered, sofa.erpCounter);
});

test("a decomposed line that is genuinely short is still caught", () => {
  assert.equal(
    verdictFor({ bookQty: 10000, bookTransfered: 10000, erpQty: 60000, erpCounter: 30000, rows: 6 }),
    "erp_low",
  );
});

test("the book moving NOTHING while the ERP claims a transfer is its own class", () => {
  // Not folded into erp_high: "the book says none and we say some" is an
  // INVENTED transfer, which migration-copy-never-compute forbids outright,
  // while erp_high is a disagreement about how much.
  assert.equal(
    verdictFor({ bookQty: 10000, bookTransfered: 0, erpQty: 10000, erpCounter: 10000, rows: 1 }),
    "erp_asserts_untransferred",
  );
});

test("a zero denominator is reported, never divided by and never called agreement", () => {
  assert.equal(verdictFor({ bookQty: 0, bookTransfered: 0, erpQty: 10000, erpCounter: 0, rows: 1 }), "book_qty_zero");
  assert.equal(verdictFor({ bookQty: 10000, bookTransfered: 10000, erpQty: 0, erpCounter: 0, rows: 1 }), "erp_qty_zero");
});

test("the comparison cannot round: 1 of 3 across 7 rows is exact", () => {
  // 1/3 vs 7/21 - a float division would land on 0.3333333333333333 twice and
  // happen to agree, and here it genuinely does. 1/3 vs 7/22 must NOT: the book
  // moved a third and we recorded 7 of 22, which is LESS, so the ERP reads LOW.
  assert.equal(verdictFor({ bookQty: 30000, bookTransfered: 10000, erpQty: 210000, erpCounter: 70000, rows: 7 }), "agree");
  assert.equal(verdictFor({ bookQty: 30000, bookTransfered: 10000, erpQty: 220000, erpCounter: 70000, rows: 7 }), "erp_low");
  // and the mirror, so the direction cannot be asserted backwards without failing
  assert.equal(verdictFor({ bookQty: 30000, bookTransfered: 10000, erpQty: 200000, erpCounter: 70000, rows: 7 }), "erp_high");
});

test("isOneToOne separates the strongest evidence from the decomposed", () => {
  assert.equal(isOneToOne({ rows: 1 }), true);
  assert.equal(isOneToOne({ rows: 6 }), false);
});

test("tally counts every verdict class and invents none", () => {
  const t = tally(selfTestCases().map((c) => c.g));
  assert.equal(Object.values(t).reduce((a, b) => a + b, 0), selfTestCases().length);
  assert.equal(t.agree, selfTestCases().filter((c) => c.want === "agree").length);
});
