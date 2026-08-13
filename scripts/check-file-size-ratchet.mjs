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
  findRaisedCeilings,
} from './lib/file-size-ratchet.mjs';

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
  const touched = new Set(['a/mine.ts']);
  const mine = v.violations.filter((x) => touched.has(x.path));
  const inherited = v.violations.filter((x) => !touched.has(x.path));
  assert.deepEqual(mine.map((x) => x.path), ['a/mine.ts']);
  assert.deepEqual(inherited.map((x) => x.path), ['a/untouched.ts']);
  assert.equal(inherited[0].over, 109, 'the inherited violation still carries its numbers — silence would let the tree drift');
});
