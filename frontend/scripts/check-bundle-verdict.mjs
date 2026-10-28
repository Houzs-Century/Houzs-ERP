// Tests for the bundle-size gate's verdict logic (scripts/lib/bundle-verdict.mjs).
//
// RUN IT WITH (from frontend/):
//   node --test scripts/check-bundle-verdict.mjs
//
// NO DEPENDENCIES, on purpose: `npm install` in a worktree destroys the main
// checkout's node_modules, so a check that needs one is a check nobody runs.
// node:test / node:assert are built in. The filename avoids `*.test.ts(x)` so
// vitest's include (`src/**/*.test.ts{,x}`, see vitest.config.ts) never collects
// it; ci.yml runs it explicitly in the frontend job.
//
// What these pin is the exact behaviour the four false failures needed:
// a PR that adds nothing must PASS while main is over budget, and a PR that
// genuinely adds weight must FAIL — with the reason naming which of the two it
// is, and the merge-base number present either way.
import assert from "node:assert/strict";
import test from "node:test";

import {
  KB,
  REASON,
  VERDICT,
  evaluateMetric,
  evaluateAll,
  formatResult,
  explainResult,
} from "./lib/bundle-verdict.mjs";

const CEILING = 1800 * KB;
const GROWTH = 60 * KB;
const metric = (current, baseline, over = {}) =>
  evaluateMetric({
    label: "total JS (gzip)",
    current,
    baseline,
    ceiling: CEILING,
    growth: GROWTH,
    ...over,
  });

// ---------------------------------------------------------------------------
// The regression that forced this rewrite.

test("docs-only PR #873: main is at the ceiling, the PR adds nothing, and it PASSES", () => {
  // The real numbers. main had consumed the 1770 KB budget; #873 touched only
  // docs/mockups/pdf/* and inherited 1770.1 through GitHub's merge build.
  const r = evaluateMetric({
    label: "total JS (gzip)",
    current: 1770.1 * KB,
    baseline: 1770.1 * KB,
    ceiling: 1770 * KB,
    growth: GROWTH,
  });
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.OVER_ON_MAIN);
  assert.equal(r.delta, 0);
  // ...and the report says whose problem it is, in those words.
  assert.match(explainResult(r), /MAIN IS ALREADY OVER THE CEILING/);
  assert.match(explainResult(r), /NOT this PR's failure/);
});

test("a PR adding a rounding error on top of an over-budget main still PASSES", () => {
  const r = metric(1801.2 * KB, 1801.1 * KB);
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.OVER_ON_MAIN);
});

// ---------------------------------------------------------------------------
// ...and the half that must keep working: genuine bloat fails.

test("a stray heavy library FAILS even when the total stays under the ceiling", () => {
  // jspdf's dependency tree was ~117 KB gzip. Under the 1800 ceiling from a
  // 1600 base, so the OLD absolute gate would have waved it through.
  const r = metric(1717 * KB, 1600 * KB);
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.PR_GROWTH);
  assert.equal(r.delta, 117 * KB);
  assert.match(explainResult(r), /THIS CHANGE adds \+117\.0 KB/);
});

test("a stray heavy library FAILS even when main is already over the ceiling", () => {
  // The nastiest case: an over-budget main must not become a licence to add.
  const r = metric(1917 * KB, 1800.5 * KB);
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.PR_GROWTH);
});

test("growth exactly at the allowance passes; one byte more fails", () => {
  assert.equal(metric(1600 * KB + GROWTH, 1600 * KB).verdict, VERDICT.PASS);
  assert.equal(metric(1600 * KB + GROWTH + 1, 1600 * KB).verdict, VERDICT.FAIL);
});

test("a PR that makes the bundle SMALLER passes, even from an over-budget base", () => {
  const r = metric(1780 * KB, 1810 * KB);
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.delta, -30 * KB);
});

// ---------------------------------------------------------------------------
// The ceiling keeps exactly one job: asking the PR that crosses it.

test("the PR that crosses a ceiling main was under is the one that FAILS", () => {
  const r = metric(1805 * KB, 1799 * KB);
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.CROSSED_CEILING);
  assert.match(explainResult(r), /the merge base was UNDER the ceiling/);
});

test("crossing the ceiling is judged on the ceiling, not on the growth allowance", () => {
  // +6 KB is well inside the 60 KB allowance, but it is what spent the budget.
  const r = metric(1805 * KB, 1799 * KB);
  assert.ok(r.delta < GROWTH);
  assert.equal(r.verdict, VERDICT.FAIL);
});

// ---------------------------------------------------------------------------
// No baseline (local run, or a CI baseline build that did not produce numbers).

test("without a baseline the ceiling is absolute, and the report says why", () => {
  const r = metric(1805 * KB, null);
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.ABSOLUTE_NO_BASELINE);
  assert.equal(r.baseline, null);
  assert.match(explainResult(r), /NO merge-base/);
});

test("without a baseline, under the ceiling still passes", () => {
  const r = metric(1700 * KB, null);
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.OK);
});

test("a non-numeric baseline is treated as absent, not as zero", () => {
  // Guards the failure mode where a corrupt baseline file reads as 0 and every
  // PR looks like it added the entire bundle.
  for (const bad of [undefined, null, NaN, "1700000"]) {
    const r = metric(1700 * KB, bad);
    assert.equal(r.baseline, null, `baseline ${String(bad)} should be treated as absent`);
    assert.equal(r.verdict, VERDICT.PASS);
  }
});

// ---------------------------------------------------------------------------
// Reporting contract.

test("the merge-base number is ALWAYS printed next to the current one", () => {
  // This is the minimum the brief demands: a reader must be able to tell
  // "main was already over" from "I added this" without leaving the log.
  const line = formatResult(metric(1801 * KB, 1800.5 * KB));
  assert.match(line, /base\s+1800\.5 KB/);
  assert.match(line, /now\s+1801\.0 KB/);
  assert.match(line, /delta\s+\+0\.5 KB/);
  assert.match(line, /ceiling 1800\.0 KB/);
});

test("with no baseline the report prints (none) rather than a misleading zero", () => {
  const line = formatResult(metric(1700 * KB, null));
  assert.match(line, /base\s+\(none\)/);
  assert.match(line, /delta\s+n\/a/);
});

test("evaluateAll fails the run when any single metric fails", () => {
  const specs = [
    { label: "initial JS (gzip)", current: 156 * KB, baseline: 156 * KB, ceiling: 165 * KB, growth: 8 * KB },
    { label: "total JS (gzip)", current: 1900 * KB, baseline: 1700 * KB, ceiling: CEILING, growth: GROWTH },
    { label: "largest chunk (raw)", current: 430 * KB, baseline: 430 * KB, ceiling: 600 * KB, growth: 100 * KB },
  ];
  const { results, failed } = evaluateAll(specs);
  assert.equal(failed, true);
  assert.deepEqual(
    results.map((r) => r.verdict),
    [VERDICT.PASS, VERDICT.FAIL, VERDICT.PASS]
  );
});

test("evaluateAll passes a docs-only PR on an over-budget main across every metric", () => {
  // The full shape of the #873 run: nothing moved, one ceiling already breached.
  const { failed, results } = evaluateAll([
    { label: "initial JS (gzip)", current: 156.1 * KB, baseline: 156.1 * KB, ceiling: 165 * KB, growth: 8 * KB },
    { label: "total JS (gzip)", current: 1770.1 * KB, baseline: 1770.1 * KB, ceiling: 1770 * KB, growth: GROWTH },
    { label: "largest chunk (raw)", current: 430 * KB, baseline: 430 * KB, ceiling: 600 * KB, growth: 100 * KB },
  ]);
  assert.equal(failed, false);
  assert.equal(results[1].reason, REASON.OVER_ON_MAIN);
});
