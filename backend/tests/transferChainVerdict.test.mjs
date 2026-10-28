/**
 * The TRANSFER-FROM classifier, exercised on the same function
 * check-ac-erp-reconcile.mjs records its `transfer from` axis off.
 *
 * NO SHEBANG — a test-imported module must not carry one (CLAUDE.md).
 *
 * ── WHY THIS TEST EXISTS AT ALL ─────────────────────────────────────────────
 * The owner, 2026-09-08: 「SO PO GR PI SI DO 等等？都解决了吗？ 然后transfer from
 * 和transfer to？」 — and the answer, before this lane, was that the chain had
 * never been an AXIS. `check-ac-erp-reconcile.mjs` read `fromDocType` /
 * `fromDocNo` / `transferedQty` ONLY to decide SCOPE, and `LOCKING_AXES` in
 * lib/so-verdict-derive.mjs carried no member for where a line came from. So a
 * line could point at the wrong source document and every report would still
 * say the sales orders tally.
 *
 * An axis added without a RED test is an axis that reports zero because it
 * never looks. Every case below was written and watched to FAIL against an
 * absent module before the module existed.
 *
 * ── THE THREE FACTS ABOUT THIS BOOK THE CASES ENCODE ───────────────────────
 * All three measured on data/ac-convert-edges.json.gz, 2026-09-07 cut, and
 * re-measured by the runner every run rather than trusted from here:
 *
 *   1. `FromDocDtlKey` IS NULL ON ALL ~220,000 ROWS of all six detail tables.
 *      So "does the source LINE agree" is answerable ONLY on the SO->PO edge,
 *      which AutoCount records differently (FromSODtlKey, 10,792 rows). On the
 *      other four edges the book states a source DOCUMENT and nothing finer,
 *      and a classifier that called that a match at LINE grain would be
 *      reporting a comparison it never made.
 *   2. `PODTL.FromDocType` IS NULL on all 18,890 PO rows while `FromDocNo` is
 *      set on 10,291. A classifier that requires a type to believe a source
 *      reports a false failure on every SO->PO line in the book.
 *   3. `PODTL.FromDocNo` can name SEVERAL sales orders in one field —
 *      lib/ac-scope.mjs already splits it on /[,;\s]+/ for exactly that reason.
 *      One purchase order raised for two sales orders must not read as a
 *      wrong link.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  FROM_VERDICTS,
  IS_DIFFERENCE,
  IS_UNANSWERABLE,
  fromVerdictFor,
  namesSource,
  runSelfTest,
  selfTestCases,
  sourceDocTokens,
} from "../scripts/lib/transfer-chain-verdict.mjs";

test("the built-in self-test passes, so the checker is allowed to run", () => {
  assert.deepEqual(runSelfTest(), []);
});

test("every planted case lands on its own verdict and nothing else", () => {
  for (const c of selfTestCases()) {
    assert.equal(fromVerdictFor(c.g), c.want, c.name);
  }
});

/* ── FACT 2: the SO->PO edge carries NO FromDocType ────────────────────────
   The single most likely way to get this lane wrong, and qa-matrix.ps1 already
   got it wrong once (check-ac-convert-symmetry.mjs, TRAP 1). */
test("a source stated with NO FromDocType is still a source — the SO->PO edge", () => {
  assert.equal(namesSource({ bookFromDocType: "", bookFromDocNo: "SO-002281" }), true);
  assert.equal(
    fromVerdictFor({
      bookFromDocType: "", bookFromDocNo: "SO-002281", bookFromLineKey: "884412",
      erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: "884412",
    }),
    "agree_line",
  );
});

test("a line the book raised from nothing is not a finding", () => {
  assert.equal(namesSource({ bookFromDocType: "", bookFromDocNo: "" }), false);
  assert.equal(
    fromVerdictFor({
      bookFromDocType: "", bookFromDocNo: "", bookFromLineKey: "",
      erpHasLink: false, erpParentDocNo: null, erpParentLineKey: null,
    }),
    "book_states_no_source",
  );
});

/* ── FACT 3: one purchase order raised for TWO sales orders ────────────────── */
test("a multi-source FromDocNo agrees when our parent is ANY of the documents it names", () => {
  assert.deepEqual(sourceDocTokens("SO-002281, SO-002282"), ["SO-002281", "SO-002282"]);
  assert.deepEqual(sourceDocTokens("SO-002281;SO-002282 SO-002283"), ["SO-002281", "SO-002282", "SO-002283"]);
  assert.equal(
    fromVerdictFor({
      bookFromDocType: "", bookFromDocNo: "SO-002281, SO-002282", bookFromLineKey: "",
      erpHasLink: true, erpParentDocNo: "SO-002282", erpParentLineKey: null,
    }),
    "agree_doc_line_unstated",
  );
});

test("a parent outside every document the book names IS a difference", () => {
  assert.equal(
    fromVerdictFor({
      bookFromDocType: "", bookFromDocNo: "SO-002281, SO-002282", bookFromLineKey: "",
      erpHasLink: true, erpParentDocNo: "SO-009999", erpParentLineKey: null,
    }),
    "doc_differs",
  );
});

/* ── FACT 1: the four edges the book cannot state a line for ───────────────── */
test("agreement at DOCUMENT grain is NOT reported as agreement at LINE grain", () => {
  const v = fromVerdictFor({
    bookFromDocType: "SO", bookFromDocNo: "SO-002281", bookFromLineKey: "",
    erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: "884412",
  });
  assert.equal(v, "agree_doc_line_unstated");
  assert.notEqual(v, "agree_line", "the book states no source LINE on this edge; claiming a line match invents one");
  assert.equal(IS_DIFFERENCE.has(v), false);
  assert.equal(IS_UNANSWERABLE.has(v), true, "the LINE half was never compared, and that must be visible");
});

test("a wrong source LINE on the one edge that states it is a difference", () => {
  assert.equal(
    fromVerdictFor({
      bookFromDocType: "", bookFromDocNo: "SO-002281", bookFromLineKey: "884412",
      erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: "884413",
    }),
    "line_differs",
  );
});

test("the right document reached through a line key we never stamped is not a line match", () => {
  const v = fromVerdictFor({
    bookFromDocType: "", bookFromDocNo: "SO-002281", bookFromLineKey: "884412",
    erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: null,
  });
  assert.equal(v, "line_not_stamped");
  assert.equal(IS_DIFFERENCE.has(v), false, "an unstamped key is a backfill, not a wrong link");
  assert.equal(IS_UNANSWERABLE.has(v), true);
});

/* ── THE TWO REAL DEFECTS THIS AXIS EXISTS TO CATCH ────────────────────────── */
test("the book raised the line from a document and we hold NO link at all", () => {
  const v = fromVerdictFor({
    bookFromDocType: "PO", bookFromDocNo: "PO-004410", bookFromLineKey: "",
    erpHasLink: false, erpParentDocNo: null, erpParentLineKey: null,
  });
  assert.equal(v, "erp_link_missing");
  assert.equal(IS_DIFFERENCE.has(v), true);
});

test("our parent carries no AutoCount number, so the two cannot be compared", () => {
  const v = fromVerdictFor({
    bookFromDocType: "PO", bookFromDocNo: "PO-004410", bookFromLineKey: "",
    erpHasLink: true, erpParentDocNo: null, erpParentLineKey: null,
  });
  assert.equal(v, "erp_parent_unstamped");
  assert.equal(IS_DIFFERENCE.has(v), false, "an ERP-native parent is not a wrong link");
  assert.equal(IS_UNANSWERABLE.has(v), true);
});

/* ── THE PROPERTY THAT KEEPS THE THREE SETS HONEST ─────────────────────────── */
test("every verdict is in exactly one of difference / unanswerable / neither", () => {
  for (const v of FROM_VERDICTS) {
    assert.equal(
      IS_DIFFERENCE.has(v) && IS_UNANSWERABLE.has(v),
      false,
      `${v} is both a difference and unanswerable — one document would be counted twice`,
    );
  }
  for (const v of [...IS_DIFFERENCE, ...IS_UNANSWERABLE]) {
    assert.equal(FROM_VERDICTS.includes(v), true, `${v} is classified but is not a declared verdict`);
  }
});

test("comparison is case- and whitespace-insensitive on the document number, and nothing else", () => {
  assert.equal(
    fromVerdictFor({
      bookFromDocType: "", bookFromDocNo: " so-002281 ", bookFromLineKey: "",
      erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: null,
    }),
    "agree_doc_line_unstated",
  );
  /* A line key is an opaque integer in AutoCount. Trimmed, never case-folded
     into something else, and never coerced through Number — 884412 and
     "884412.0" are not the same key and must not be made to look like it. */
  assert.equal(
    fromVerdictFor({
      bookFromDocType: "", bookFromDocNo: "SO-002281", bookFromLineKey: " 884412 ",
      erpHasLink: true, erpParentDocNo: "SO-002281", erpParentLineKey: "884412",
    }),
    "agree_line",
  );
});
