// Tests for the file-size ratchet's decision logic (scripts/lib/file-size-ratchet.mjs).
//
// RUN IT WITH (from the repo root):
//   node --test scripts/check-file-size-ratchet.mjs
//
// NO DEPENDENCIES, on purpose: `npm install` in a worktree destroys the main
// checkout's node_modules, so a check that needs one is a check nobody runs.
// node:test / node:assert are built in. The filename avoids `*.test.ts(x)` so
// neither vitest project collects it; ci.yml runs it explicitly.
//
// What these pin is the ratchet's whole contract, because a ratchet that can be
// loosened is just a suggestion:
//   · a new file over the cap FAILS, an existing big file is grandfathered
//   · shrinking always passes and never needs a manifest edit to stay green
//   · an over-ceiling file may be EDITED: net-zero and net-negative diffs land,
//     +1 does not, and the report never calls a touched file untouched
//   · --update can only LOWER a ceiling, never raise one to clear a violation
//   · raising a ceiling by hand is caught against the merge base
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NEW_FILE_LIMIT,
  isGeneratedHeader,
  ceilingFor,
  verdict,
  lowerCeilings,
  classifyViolations,
  findRaisedCeilings, uncommittedSourcePaths } from './lib/file-size-ratchet.mjs';

test('a new file over the cap fails; under the cap it needs no entry', () => {
  const v = verdict(
    [
      { path: 'a/new-huge.ts', lines: 3000 },
      { path: 'a/new-fine.ts', lines: 1999 },
    ],
    {},
  );
  assert.equal(v.ok, false);
  assert.equal(v.violations.length, 1);
  assert.equal(v.violations[0].path, 'a/new-huge.ts');
  assert.equal(v.violations[0].grandfathered, false);
  assert.equal(v.violations[0].over, 1000);
});

test('an existing big file is grandfathered at its recorded size', () => {
  const ceilings = { 'so/route.ts': 12094 };
  assert.equal(verdict([{ path: 'so/route.ts', lines: 12094 }], ceilings).ok, true);
  const grown = verdict([{ path: 'so/route.ts', lines: 12095 }], ceilings);
  assert.equal(grown.ok, false);
  assert.equal(grown.violations[0].over, 1);
  assert.equal(grown.violations[0].grandfathered, true);
});

test('shrinking is free and reported as slack, never as a failure', () => {
  const v = verdict([{ path: 'so/route.ts', lines: 9000 }], { 'so/route.ts': 12094 });
  assert.equal(v.ok, true);
  assert.deepEqual(v.shrunk, [{ path: 'so/route.ts', lines: 9000, ceiling: 12094 }]);
  // Still above the cap, so it keeps its entry.
  assert.equal(v.belowLimit.length, 0);
});

test('a file that falls to the cap is flagged to leave the manifest for good', () => {
  const v = verdict([{ path: 'so/route.ts', lines: 1500 }], { 'so/route.ts': 12094 });
  assert.equal(v.ok, true);
  assert.equal(v.belowLimit.length, 1);
  // ...and --update drops it, after which the shared cap binds it forever.
  const next = lowerCeilings([{ path: 'so/route.ts', lines: 1500 }], { 'so/route.ts': 12094 });
  assert.deepEqual(next, {});
  assert.equal(ceilingFor('so/route.ts', next), NEW_FILE_LIMIT);
});

test('--update lowers a ceiling but will NOT raise one to clear a violation', () => {
  const ceilings = { 'big.ts': 2500 };
  // Shrunk -> ceiling follows it down.
  assert.deepEqual(lowerCeilings([{ path: 'big.ts', lines: 2300 }], ceilings), { 'big.ts': 2300 });
  // Grown -> ceiling stays put, so the gate stays red until the file shrinks.
  assert.deepEqual(lowerCeilings([{ path: 'big.ts', lines: 2800 }], ceilings), { 'big.ts': 2500 });
  assert.equal(verdict([{ path: 'big.ts', lines: 2800 }], { 'big.ts': 2500 }).ok, false);
});

test('a ceiling raised by hand is caught against the merge base', () => {
  const raised = findRaisedCeilings({ 'big.ts': 2500 }, { 'big.ts': 9999 });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].from, 2500);
  assert.equal(raised[0].to, 9999);
});

test('newly grandfathering a file is a raise too', () => {
  const raised = findRaisedCeilings({}, { 'sneaky.ts': 5000 });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].reason, 'newly grandfathered');
});

test('a ceiling falling, or an entry leaving, is the ratchet working — not a raise', () => {
  assert.deepEqual(findRaisedCeilings({ 'big.ts': 2500 }, { 'big.ts': 2200 }), []);
  assert.deepEqual(findRaisedCeilings({ 'big.ts': 2500 }, {}), []);
});

test('stale manifest entries are reported without failing the gate', () => {
  const v = verdict([{ path: 'kept.ts', lines: 10 }], { 'deleted.ts': 3000 });
  assert.equal(v.ok, true);
  assert.deepEqual(v.stale, ['deleted.ts']);
});

test('generated headers are recognised only in the first few lines', () => {
  assert.equal(isGeneratedHeader(['// GENERATED FILE — do not edit by hand.']), true);
  assert.equal(isGeneratedHeader(['// @generated']), true);
  assert.equal(isGeneratedHeader(['a', 'b', 'c', 'd', 'e', '// GENERATED FILE']), false);
  assert.equal(isGeneratedHeader(['import x from "y";']), false);
});

/* ── classifyViolations: who pays ──────────────────────────────────────────
   These used to re-implement the charge rule inline, with their own `filter`
   over `touched` and `atBase`. That is a test of a copy: the production rule
   lived in check-file-size.mjs among the git shell-outs and had NO test on it,
   so it could have drifted from these assertions without one of them going red.
   They now call the shipped function. */

test('a violation in a file the change does not touch is reported, not charged', () => {
  /* 2026-08-14: grns.ts went 109 lines over on main — file-size is not one of
     the ruleset's required checks, so the PR that grew it merged red. Every
     open branch then inherited the failure, including a production fix that
     never opened the file. Whoever grows a file owns its ceiling. */
  const measured = [
    { path: 'a/untouched.ts', lines: 3591 },
    { path: 'a/mine.ts', lines: 2200 },
  ];
  const ceilings = { 'a/untouched.ts': 3482, 'a/mine.ts': 2100 };
  const v = verdict(measured, ceilings, 2000);
  const c = classifyViolations(v.violations, new Set(['a/mine.ts']), new Map([['a/mine.ts', 2100]]));
  assert.deepEqual(c.charged.map((x) => x.path), ['a/mine.ts']);
  assert.deepEqual(c.untouched.map((x) => x.path), ['a/untouched.ts']);
  assert.equal(c.untouched[0].over, 109, 'the inherited violation still carries its numbers — silence would let the tree drift');
});

test('a touched file already over its ceiling passes if this change SHRANK it', () => {
  /* 2026-08-14, PR #2127: grns.ts was 3,591 on main (109 over its ceiling) and
     3,586 on the branch — the branch had moved it in the only direction the
     ratchet asks for, and was failed for it. The subject is GROWTH. */
  const measured = [{ path: 'a/big.ts', lines: 3586 }];
  const ceilings = { 'a/big.ts': 3482 };
  const v = verdict(measured, ceilings, 2000);
  assert.equal(v.violations.length, 1, 'still a violation — the debt is real and stays reported');

  const touched = new Set(['a/big.ts']);
  const shrank = classifyViolations(v.violations, touched, new Map([['a/big.ts', 3591]]));
  assert.deepEqual(shrank.charged, [], 'shrinking a file already over its ceiling is not chargeable');
  assert.deepEqual(shrank.touchedNotGrown.map((x) => x.delta), [-5], 'and the report says by how much');

  const grew = classifyViolations(v.violations, touched, new Map([['a/big.ts', 3500]]));
  assert.equal(grew.charged.length, 1, 'growing it further is charged from the first line');
  assert.equal(grew.charged[0].delta, 86);
});

test('a NET-ZERO diff on an over-ceiling file lands — the rule is growth, not debt', () => {
  /* The shape the gate has to get right, and the one it explained worst. On
     2026-08-17 a four-line correctness fix to grns.ts was reported as
     `over by 170` — the file's whole inherited debt — and reverted, when the
     charge was four lines. Same size in and out is not growth. */
  const v = verdict([{ path: 'a/big.ts', lines: 3648 }], { 'a/big.ts': 3482 }, 2000);
  const c = classifyViolations(v.violations, new Set(['a/big.ts']), new Map([['a/big.ts', 3648]]));
  assert.deepEqual(c.charged, [], 'a net-zero edit of an over-ceiling file is not charged');
  assert.equal(c.touchedNotGrown.length, 1);
  assert.equal(c.touchedNotGrown[0].delta, 0);
  assert.equal(c.touchedNotGrown[0].over, 166, 'the debt is still REPORTED — it just is not this author\'s bill');
});

test('ONE added line over the ceiling still fails — the door does not open', () => {
  /* The half of the rule that must never soften. If a net-non-positive diff is
     free, the only thing standing between this repo and unbounded growth is that
     +1 is charged, so it is pinned on its own. */
  const v = verdict([{ path: 'a/big.ts', lines: 3649 }], { 'a/big.ts': 3482 }, 2000);
  const c = classifyViolations(v.violations, new Set(['a/big.ts']), new Map([['a/big.ts', 3648]]));
  assert.equal(c.charged.length, 1);
  assert.equal(c.charged[0].delta, 1);
  assert.deepEqual(c.touchedNotGrown, []);
});

test('growing a file that was UNDER its ceiling at the base is charged', () => {
  /* max(ceiling, sizeAtBase) is the allowance, and when the file sat below its
     ceiling the ceiling is the binding half. Shrinking-then-growing back past
     the ceiling must not be laundered by the base comparison. */
  const v = verdict([{ path: 'a/big.ts', lines: 3500 }], { 'a/big.ts': 3482 }, 2000);
  const c = classifyViolations(v.violations, new Set(['a/big.ts']), new Map([['a/big.ts', 3400]]));
  assert.equal(c.charged.length, 1, 'over the ceiling AND grown — charged');
});

test('a file with no size at the merge base is charged in full', () => {
  /* Added or renamed on this branch: there is nothing to have grown FROM, so
     the whole file is this change\'s doing. Silently passing it is how a new
     3,000-line module walks in behind a rename. */
  const v = verdict([{ path: 'a/new.ts', lines: 2400 }], {}, 2000);
  const c = classifyViolations(v.violations, new Set(['a/new.ts']), new Map());
  assert.equal(c.charged.length, 1);
  assert.equal(c.charged[0].wasAtBase, null);
  assert.equal(c.charged[0].delta, null, 'no delta to report, and the message must say why');
});

test('an unresolvable merge base charges EVERYTHING, touched or not', () => {
  /* A gate that cannot tell whose fault it is must not let anything through —
     the same rule as the three refusals in check-file-size.mjs. */
  const v = verdict(
    [{ path: 'a/one.ts', lines: 3600 }, { path: 'a/two.ts', lines: 2400 }],
    { 'a/one.ts': 3482 },
    2000,
  );
  const c = classifyViolations(v.violations, null, null);
  assert.equal(c.charged.length, 2);
  assert.deepEqual(c.untouched, []);
  assert.deepEqual(c.touchedNotGrown, []);
});

test('a touched-but-shrunk file is NOT reported as untouched', () => {
  /* The reporting bug this bucket exists to kill. Measured 2026-08-18 on
     origin/main: deleting four blank lines from grns.ts passed the gate, and the
     pass printed the file under "OVER CEILING, but not touched by this change".
     Telling an author the gate never saw their edit is how a correct edit gets
     re-litigated. */
  const v = verdict([{ path: 'a/big.ts', lines: 3644 }], { 'a/big.ts': 3482 }, 2000);
  const c = classifyViolations(v.violations, new Set(['a/big.ts']), new Map([['a/big.ts', 3648]]));
  assert.deepEqual(c.untouched, [], 'a file in the diff is never in the untouched bucket');
  assert.deepEqual(c.touchedNotGrown.map((x) => x.path), ['a/big.ts']);
});

/* ── uncommittedSourcePaths ────────────────────────────────────────────────
   The gate reads the COMMITTED tree. Anything the working tree holds is
   invisible to it, so the caller REFUSES rather than answering — see the
   function's own header. These cases are the parse, which is the only part a
   test can reach without a git repository. */

test('a modified source file is reported', () => {
  const z = ' M scripts/check-file-size.mjs\0';
  assert.deepEqual(uncommittedSourcePaths(z, ['.mjs']), ['scripts/check-file-size.mjs']);
});

test('STAGED counts too — the gate cannot see the index either', () => {
  const z = 'M  a.mjs\0A  b.mjs\0';
  assert.deepEqual(uncommittedSourcePaths(z, ['.mjs']), ['a.mjs', 'b.mjs']);
});

test('a rename reports where the file LANDED, not where it was', () => {
  // `R  old -> new`. Measuring the old path would look for a file that is gone.
  const z = 'R  scripts/old.mjs -> scripts/new.mjs\0';
  assert.deepEqual(uncommittedSourcePaths(z, ['.mjs']), ['scripts/new.mjs']);
});

test('a non-source file is not reported — the gate does not measure it', () => {
  const z = ' M README.md\0 M docs/CODEBASE-MAP.md\0';
  assert.deepEqual(uncommittedSourcePaths(z, ['.mjs', '.ts']), []);
});

test('a clean tree reports nothing, so the gate answers normally', () => {
  assert.deepEqual(uncommittedSourcePaths('', ['.mjs']), []);
  assert.deepEqual(uncommittedSourcePaths(undefined, ['.mjs']), []);
});

test('a path containing a space survives — porcelain -z does not quote it', () => {
  const z = ' M src/my file.ts\0';
  assert.deepEqual(uncommittedSourcePaths(z, ['.ts']), ['src/my file.ts']);
});

test('the same path twice is reported once', () => {
  const z = ' M a.ts\0 M a.ts\0';
  assert.deepEqual(uncommittedSourcePaths(z, ['.ts']), ['a.ts']);
});
