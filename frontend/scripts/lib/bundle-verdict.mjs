// The verdict half of the bundle-size gate, kept pure and dependency-free so it
// can be tested without a build (see ../check-bundle-verdict.mjs).
//
// WHY THIS EXISTS AT ALL
//
// The gate used to be a set of ABSOLUTE ceilings measured on whatever tree CI
// happened to build. On a `pull_request` event GitHub builds the MERGE of the PR
// with main, so every PR inherits main's current bundle. When main consumed the
// budget, the next PR to run — any PR, including one that touched no source at
// all — was the one that failed. That happened four times in eight days:
//
//   2026-07-16  a +0.3 KB change failed a budget main had already spent
//   2026-07-19  two unrelated branches tripped the same spent budget hours apart
//   2026-07-20  a cosmetic page-titles PR failed at exactly the ceiling
//   2026-07-21  docs-only PR #873 (docs/mockups/pdf/* only, ZERO source files)
//               failed `total JS (gzip) 1770.1 KB / 1770.0 KB` — over by 0.1 KB
//               it could not possibly have added. Its sibling #860 passed only
//               because it ran a few hours earlier.
//
// Each time the answer was to raise the number, which is not a fix: it resets
// the fuse and guarantees a fifth occurrence. The defect is that an absolute
// total answers the question "how big is main + this PR?" while CI is being
// asked "did this PR make things worse?".
//
// WHAT REPLACES IT
//
// Every metric is judged against a BASELINE measured on the merge base (main),
// built by the same toolchain in the same CI run. The primary verdict is the
// DELTA — a PR's own growth — with an absolute ceiling retained but demoted so
// it can only ever fail the PR that actually crosses it:
//
//   1. delta > growth allowance          -> FAIL  (PR_GROWTH)
//   2. current > ceiling, baseline under -> FAIL  (CROSSED_CEILING) — this PR is
//                                                  the one that crossed a
//                                                  documented ceiling; say so.
//   3. current > ceiling, baseline over  -> PASS  (OVER_ON_MAIN) — loud, printed
//                                                  on every run, but not this
//                                                  PR's failure.
//   4. otherwise                         -> PASS
//
// With no baseline (a local `npm run build && npm run check:bundle`, or a CI run
// whose baseline build failed) the ceiling is enforced absolutely as before, and
// the report says so — a developer at their desk should still be told the tree
// is over, they just should not be told it is their fault.
//
// Genuine bloat still fails: a stray heavy library on the always-loaded path is
// tens to hundreds of KB, which blows the growth allowance no matter what main
// is doing, and no matter how much headroom the ceiling has.

export const KB = 1000;

/**
 * Reasons a metric can end up in each verdict. Kept as constants so the tests
 * assert on the reason and not on prose that will be reworded.
 */
export const VERDICT = {
  PASS: "PASS",
  FAIL: "FAIL",
};

export const REASON = {
  OK: "OK",
  PR_GROWTH: "PR_GROWTH",
  CROSSED_CEILING: "CROSSED_CEILING",
  OVER_ON_MAIN: "OVER_ON_MAIN",
  ABSOLUTE_NO_BASELINE: "ABSOLUTE_NO_BASELINE",
};

/**
 * Evaluate one metric.
 *
 * @param {object} spec
 * @param {string} spec.label
 * @param {number} spec.current   measured on the tree under test
 * @param {number|null} spec.baseline measured on the merge base, or null
 * @param {number} spec.ceiling   absolute budget (bytes)
 * @param {number|null} spec.growth allowance for this PR's own growth (bytes);
 *                                  null means "no growth rule, ceiling only"
 */
export function evaluateMetric({ label, current, baseline, ceiling, growth }) {
  const hasBaseline = typeof baseline === "number" && Number.isFinite(baseline);
  const delta = hasBaseline ? current - baseline : null;

  if (hasBaseline && typeof growth === "number" && delta > growth) {
    return {
      label,
      current,
      baseline,
      delta,
      ceiling,
      growth,
      verdict: VERDICT.FAIL,
      reason: REASON.PR_GROWTH,
    };
  }
  if (current > ceiling) {
    if (!hasBaseline) {
      return {
        label,
        current,
        baseline: null,
        delta: null,
        ceiling,
        growth,
        verdict: VERDICT.FAIL,
        reason: REASON.ABSOLUTE_NO_BASELINE,
      };
    }
    if (baseline <= ceiling) {
      return {
        label,
        current,
        baseline,
        delta,
        ceiling,
        growth,
        verdict: VERDICT.FAIL,
        reason: REASON.CROSSED_CEILING,
      };
    }
    return {
      label,
      current,
      baseline,
      delta,
      ceiling,
      growth,
      verdict: VERDICT.PASS,
      reason: REASON.OVER_ON_MAIN,
    };
  }
  return {
    label,
    current,
    baseline: hasBaseline ? baseline : null,
    delta,
    ceiling,
    growth,
    verdict: VERDICT.PASS,
    reason: REASON.OK,
  };
}

/** Evaluate every metric. Returns { results, failed }. */
export function evaluateAll(specs) {
  const results = specs.map(evaluateMetric);
  return { results, failed: results.some((r) => r.verdict === VERDICT.FAIL) };
}

const kb = (n) => `${(n / KB).toFixed(1)} KB`;
const signedKb = (n) => `${n >= 0 ? "+" : "-"}${(Math.abs(n) / KB).toFixed(1)} KB`;

/**
 * One human-readable line per metric. The MERGE-BASE NUMBER IS ALWAYS PRINTED
 * next to the current one — that is the minimum a reader needs to tell "main was
 * already over" from "I added this", and its absence is what made four separate
 * PRs look guilty.
 */
export function formatResult(r) {
  const baselineText = r.baseline === null ? "  (none)" : kb(r.baseline).padStart(9);
  const deltaText = r.delta === null ? "     n/a" : signedKb(r.delta).padStart(9);
  return (
    `  ${r.verdict === VERDICT.FAIL ? "FAIL" : "PASS"}  ${r.label.padEnd(26)}` +
    ` base ${baselineText}  ->  now ${kb(r.current).padStart(9)}  ` +
    ` delta ${deltaText}` +
    (r.growth === null || r.growth === undefined ? "" : ` / ${kb(r.growth)} allowed`) +
    `   ceiling ${kb(r.ceiling)}`
  );
}

/**
 * The explanation printed under a failing (or over-on-main) metric. This is the
 * part that has to blame the right change.
 */
export function explainResult(r) {
  switch (r.reason) {
    case REASON.PR_GROWTH:
      return (
        `  ${r.label}: THIS CHANGE adds ${signedKb(r.delta)} over the merge base ` +
        `(${kb(r.baseline)} -> ${kb(r.current)}), and the allowance is ${kb(r.growth)}.\n` +
        `    Split or trim what was added, or — if the growth is intentional — raise the\n` +
        `    growth allowance for this metric in frontend/scripts/check-bundle-size.mjs and\n` +
        `    say why in the diff.`
      );
    case REASON.CROSSED_CEILING:
      return (
        `  ${r.label}: the merge base was UNDER the ceiling (${kb(r.baseline)} / ${kb(r.ceiling)})\n` +
        `    and this change crosses it (${kb(r.current)}, ${signedKb(r.delta)}). This PR is the\n` +
        `    one that spent the last of the budget, so it is the one being asked whether that\n` +
        `    is intentional. If it is, raise the ceiling here with a dated note.`
      );
    case REASON.OVER_ON_MAIN:
      return (
        `  ${r.label}: MAIN IS ALREADY OVER THE CEILING (${kb(r.baseline)} / ${kb(r.ceiling)}).\n` +
        `    This is NOT this PR's failure — it adds ${signedKb(r.delta)} — and the gate does not\n` +
        `    fail it for someone else's growth. The ceiling still needs a deliberate decision on\n` +
        `    main: trim, or raise it with a dated note in frontend/scripts/check-bundle-size.mjs.`
      );
    case REASON.ABSOLUTE_NO_BASELINE:
      return (
        `  ${r.label}: over the ceiling (${kb(r.current)} / ${kb(r.ceiling)}) and NO merge-base\n` +
        `    baseline was available, so the gate cannot tell whether this change caused it.\n` +
        `    In CI that means the baseline build did not produce a measurement — check the\n` +
        `    "bundle baseline" step. Locally, pass --baseline <file> or read this as "the tree\n` +
        `    is over", not as "you did this".`
      );
    default:
      return "";
  }
}
