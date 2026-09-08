/**
 * THE AXIS, not the classifier — that the transfer chain actually reaches the
 * verdict a person reads.
 *
 * NO SHEBANG — a test-imported module must not carry one (CLAUDE.md).
 *
 * ── WHY THIS IS A SEPARATE FILE FROM transferChainVerdict.test.mjs ─────────
 * That one proves the CLASSIFIER answers correctly. This one proves the answer
 * is not thrown away on the way to the report, which is a different failure and
 * the more likely one here: `makeVerdictRecorder().record()` is a deliberate
 * NO-OP for any axis outside `LOCKING_AXES`, so a lane that computes a perfect
 * verdict and records it under an undeclared name reports ZERO, silently,
 * forever. An axis added without a red test is an axis that reports zero
 * because it never looks.
 *
 * Every assertion below was watched to FAIL before the axis names were added to
 * lib/so-verdict-derive.mjs — the record() call was swallowed and the document
 * came back `identical`.
 *
 * ── AND THAT THE OWNER'S THREE SILENCES NEVER LOCK ────────────────────────
 * The book records no source LINE on four of five edges, a sales order is the
 * head of its chain, and two edges store no ERP counter at all. None of those
 * is a defect of ours. Each is a DECLARED class, and a declared class counted
 * as work is docs/bugs/0715 exactly.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  LOCKING_AXES, NOTE_CLASSES, UNANSWERABLE_AXES,
  buildVerdictRows, makeVerdictRecorder, summariseVerdict,
} from "../scripts/lib/so-verdict-derive.mjs";
import { AXIS_GROUPS, bucketOf, isTallied, tallyVerdict } from "../scripts/lib/so-tally-verdict.mjs";
import {
  AXIS_FROM, AXIS_TO, AXIS_UNVERIFIABLE,
  NOTE_LINE_NOT_IN_BOOK, NOTE_NO_ERP_COUNTER, NOTE_NO_SOURCE,
} from "../scripts/lib/ac-transfer-chain-run.mjs";

const rowsFor = (record) => {
  const r = makeVerdictRecorder();
  r.seen("PO", "PO-004410", "PO-2609-001");
  record(r);
  return buildVerdictRows({ recorder: r, type: "PO", companyId: 1, measuredAt: "t", runId: "r" });
};

const payloadOf = (rows) => ({ rows, summary: summariseVerdict(rows), population: {}, presence: {} });

describe("the chain axes are DECLARED, so the recorder does not swallow them", () => {
  for (const axis of [AXIS_FROM, AXIS_TO, AXIS_UNVERIFIABLE]) {
    it(`"${axis}" is a locking axis`, () => {
      assert.ok(LOCKING_AXES.includes(axis), `${axis} is not in LOCKING_AXES — record() would be a silent no-op`);
    });

    it(`"${axis}" belongs to an AXIS_GROUP, so the owner's report prints it`, () => {
      const group = AXIS_GROUPS.find((g) => g.axes.includes(axis));
      assert.ok(group, `${axis} is in no AXIS_GROUP — the lock would shut documents for a difference nobody prints`);
      assert.equal(group.key, "transfer-chain");
    });
  }

  for (const klass of [NOTE_LINE_NOT_IN_BOOK, NOTE_NO_SOURCE, NOTE_NO_ERP_COUNTER]) {
    it(`"${klass}" is a declared NOTE class`, () => {
      assert.ok(NOTE_CLASSES.includes(klass), `${klass} is not in NOTE_CLASSES — note() would be a silent no-op`);
    });
  }
});

describe("a wrong or missing source link LOCKS the document", () => {
  it("a wrong source document is WORK", () => {
    const rows = rowsFor((r) =>
      r.record("PO", "PO-004410", "PO-2609-001", AXIS_FROM, "doc_differs: we point at SO-009999", true));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clean, false);
    assert.deepEqual(rows[0].axes, [AXIS_FROM]);
    assert.deepEqual(rows[0].axes_proceeded, [AXIS_FROM], "the PROCEEDED arm is what the owner reads first");
    assert.equal(bucketOf(rows[0]), "work");
    assert.equal(isTallied(tallyVerdict(payloadOf(rows))), false);
  });

  it("a transfer counter that disagrees with the book is WORK", () => {
    const rows = rowsFor((r) =>
      r.record("PO", "PO-004410", "PO-2609-001", AXIS_TO, "erp_low: the book moved 5 of 10, we record 2", true));
    assert.equal(bucketOf(rows[0]), "work");
    assert.equal(isTallied(tallyVerdict(payloadOf(rows))), false);
  });
});

describe("what could NOT be compared does not lock, and is not agreement either", () => {
  it(`"${AXIS_UNVERIFIABLE}" is unanswerable — the document is not TALLIED-blocking, and not clean`, () => {
    assert.ok(UNANSWERABLE_AXES.includes(AXIS_UNVERIFIABLE));
    const rows = rowsFor((r) =>
      r.record("PO", "PO-004410", "PO-2609-001", AXIS_UNVERIFIABLE, "erp_parent_unstamped", true));
    assert.equal(rows[0].clean, false, "「我们没看过」 must never open a document");
    assert.equal(bucketOf(rows[0]), "unanswerable");
    /* It does NOT block TALLIED, exactly like an unreadable sofa build: it is
       the owner's to adjudicate, and it is printed beside the verdict so
       TALLIED can never be read as "everything was compared". */
    assert.equal(isTallied(tallyVerdict(payloadOf(rows))), true);
    assert.equal(tallyVerdict(payloadOf(rows)).buckets.unanswerable, 1);
  });
});

describe("the owner's three silences are DECLARED, and a declared class is never work", () => {
  const cases = [
    [NOTE_LINE_NOT_IN_BOOK, "the book records no source LINE on this edge"],
    [NOTE_NO_SOURCE, "the book raised this line from nothing"],
    [NOTE_NO_ERP_COUNTER, "this edge stores no counter in the ERP"],
  ];
  for (const [klass, why] of cases) {
    it(`${klass} — ${why} — leaves the document clean`, () => {
      const rows = rowsFor((r) => r.note("PO", "PO-004410", "PO-2609-001", klass, AXIS_FROM, why, true));
      assert.equal(rows[0].clean, true, `${klass} must not lock — a declared class counted as work is docs/bugs/0715`);
      assert.equal(bucketOf(rows[0]), "identical");
      assert.equal(isTallied(tallyVerdict(payloadOf(rows))), true);
      /* Declared is not silent: it is counted and named, or it is a suppression
         nobody can enumerate (docs/bugs/0668). */
      const v = tallyVerdict(payloadOf(rows));
      assert.ok(v.declared.some((d) => d.klass === klass && d.findings === 1));
    });
  }
});

describe("adding this axis did not move what the OTHER axes say", () => {
  it("a document differing on quantity alone is unchanged by the chain axes existing", () => {
    const rows = rowsFor((r) => r.record("PO", "PO-004410", "PO-2609-001", "quantity", "qty 5 vs 3", true));
    assert.deepEqual(rows[0].axes, ["quantity"]);
    assert.equal(bucketOf(rows[0]), "work");
    const v = tallyVerdict(payloadOf(rows));
    assert.deepEqual(v.axes.map((a) => a.axis), ["quantity"]);
    assert.equal(v.groups.find((g) => g.key === "transfer-chain").work.docs, 0);
  });

  it("a document with NO findings is still identical, and the chain group reads zero", () => {
    const rows = rowsFor(() => {});
    assert.equal(rows[0].clean, true);
    const v = tallyVerdict(payloadOf(rows));
    assert.equal(v.groups.find((g) => g.key === "transfer-chain").work.docs, 0);
    assert.equal(v.groups.find((g) => g.key === "transfer-chain").unanswerable.docs, 0);
  });
});
