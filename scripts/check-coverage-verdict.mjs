// Tests for the coverage ratchet's own logic (scripts/lib/coverage-verdict.mjs).
//
// RUN IT WITH (from the repo root):
//   node --test scripts/check-coverage-verdict.mjs
//
// NO DEPENDENCIES, on purpose — same rule as frontend/scripts/check-bundle-verdict.mjs:
// `npm install` in a worktree destroys the main checkout's node_modules, so a
// check that needs one is a check nobody runs. The filename avoids `*.test.ts`
// so neither vitest project collects it; ci.yml runs it explicitly.
//
// WHAT THESE PIN, and why each one exists rather than "for coverage":
//  · a gate whose scan found nothing must FAIL, not report 100%
//  · a denominator that shrank must FAIL, because a shrinking denominator is a
//    RISING percentage — the false green that looks like progress
//  · two shard reports of the same tree merge by SUMMING hits; two reports of
//    DIFFERENT trees are refused rather than averaged into a fiction
//  · a new untested file must FAIL even when it barely moves the percentage —
//    that is the whole reason the second floor exists

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOC_END,
  DOC_START,
  FATAL,
  VERDICT,
  evaluate,
  floorFor,
  lineCoverageOf,
  mergeCoverage,
  nextBaseline,
  pct,
  renderDocTable,
  spliceDocTable,
  summarise,
} from './lib/coverage-verdict.mjs';

/** An istanbul FileCoverage for a file whose statements start on `lines`,
 *  with `hits` per statement. */
const cov = (lines, hits) => ({
  statementMap: Object.fromEntries(lines.map((l, i) => [String(i), { start: { line: l, column: 0 } }])),
  s: Object.fromEntries(lines.map((_, i) => [String(i), hits[i] ?? 0])),
});

const AREAS = [
  { id: 'backend/src/scm/lib', dir: 'backend/src/scm/lib', exts: ['.ts'] },
  { id: 'frontend/src', dir: 'frontend/src', exts: ['.tsx'] },
];
const areaOf = (rel) => AREAS.find((a) => rel.startsWith(`${a.dir}/`)) ?? null;

// ---------------------------------------------------------------------------
// line arithmetic
// ---------------------------------------------------------------------------

test('a line counts as covered when ANY statement on it ran', () => {
  // Two statements share line 4; one ran. istanbul takes the max, so the line
  // is covered — reimplementing this wrong is how the gate's number would stop
  // matching the number vitest prints, and then nobody trusts either.
  const c = cov([3, 4, 4], [0, 0, 7]);
  assert.deepEqual(lineCoverageOf(c), { total: 2, covered: 1 });
});

test('a file with no statements contributes no lines at all', () => {
  assert.deepEqual(lineCoverageOf({ statementMap: {}, s: {} }), { total: 0, covered: 0 });
});

test('pct rounds to 2dp and does not invent precision', () => {
  assert.equal(pct(1, 3), 33.33);
  assert.equal(pct(0, 10), 0);
  assert.equal(pct(10, 10), 100);
});

// ---------------------------------------------------------------------------
// merging shard reports
// ---------------------------------------------------------------------------

test('two shards of the same file merge by SUMMING hits, not by overwriting', () => {
  // CI shards the backend suite across four runners. Each shard reports every
  // file, and only the union is the truth: shard 1 covers line 1, shard 2 covers
  // line 2, and the file is 100% covered even though neither shard saw that.
  const merged = mergeCoverage([
    { 'backend/src/scm/lib/a.ts': cov([1, 2], [3, 0]) },
    { 'backend/src/scm/lib/a.ts': cov([1, 2], [0, 5]) },
  ]);
  assert.deepEqual(lineCoverageOf(merged['backend/src/scm/lib/a.ts']), { total: 2, covered: 2 });
});

test('reports from DIFFERENT trees are refused, never averaged', () => {
  // A stale artifact left in the download directory, or one shard on an older
  // commit. Merging those produces a number describing no tree that exists.
  assert.throws(
    () =>
      mergeCoverage([
        { 'backend/src/scm/lib/a.ts': cov([1, 2], [1, 1]) },
        { 'backend/src/scm/lib/a.ts': cov([1, 2, 3], [1, 1, 1]) },
      ]),
    (err) => err.code === FATAL.SHAPE_MISMATCH,
  );
});

// ---------------------------------------------------------------------------
// the sanity checks that make a green result mean something
// ---------------------------------------------------------------------------

test('an area that matched ZERO files is fatal, not 100%', () => {
  // The moved-directory case. `pct(0, 0)` is 100 by convention, so without this
  // check a scanner pointed at nothing reports a perfect score forever.
  const s = summarise({}, AREAS, areaOf, { 'backend/src/scm/lib': [], 'frontend/src': [] });
  assert.equal(s.areas[0].pct, 100, 'the convention itself is unchanged');
  const codes = s.fatal.map((f) => f.code);
  assert.deepEqual(codes, [FATAL.EMPTY_AREA, FATAL.EMPTY_AREA]);
  assert.equal(evaluate(s, { areas: {} }).ok, false);
});

test('a file on disk but absent from the report is fatal — a short denominator is a HIGH percentage', () => {
  // This is what `coverage.all: false` looks like from here: the untested file
  // vanishes, and the area appears to jump from 50% to 100%.
  const merged = { 'backend/src/scm/lib/a.ts': cov([1, 2], [1, 1]) };
  const onDisk = { 'backend/src/scm/lib': ['backend/src/scm/lib/a.ts', 'backend/src/scm/lib/b.ts'], 'frontend/src': ['frontend/src/x.tsx'] };
  const s = summarise(merged, AREAS, areaOf, onDisk);
  assert.equal(s.areas[0].pct, 100, 'the reported files really are fully covered');
  const missing = s.fatal.find((f) => f.code === FATAL.MISSING_FILES);
  assert.ok(missing, 'but the gate must refuse the number');
  assert.deepEqual(missing.files, ['backend/src/scm/lib/b.ts']);
});

test('a file listed as knownAbsent does not trip the missing-file check', () => {
  // The escape hatch is explicit and committed, so an unexplained absence still
  // fails while a documented one does not.
  const merged = { 'backend/src/scm/lib/a.ts': cov([1], [1]), 'frontend/src/x.tsx': cov([1], [1]) };
  const onDisk = { 'backend/src/scm/lib': ['backend/src/scm/lib/a.ts', 'backend/src/scm/lib/b.ts'], 'frontend/src': ['frontend/src/x.tsx'] };
  const s = summarise(merged, AREAS, areaOf, onDisk, ['backend/src/scm/lib/b.ts']);
  assert.deepEqual(s.fatal, []);
});

test('files outside every area are measured and reported, not silently dropped', () => {
  const merged = {
    'backend/src/scm/lib/a.ts': cov([1], [1]),
    'frontend/src/x.tsx': cov([1], [1]),
    'backend/src/services/permissions.ts': cov([1, 2], [1, 0]),
  };
  const onDisk = { 'backend/src/scm/lib': ['backend/src/scm/lib/a.ts'], 'frontend/src': ['frontend/src/x.tsx'] };
  const s = summarise(merged, AREAS, areaOf, onDisk);
  assert.deepEqual(s.fatal, []);
  assert.equal(s.unratcheted.files, 1);
  assert.equal(s.unratcheted.pct, 50);
});

// ---------------------------------------------------------------------------
// the ratchet
// ---------------------------------------------------------------------------

const twoAreaSummary = (libFiles, feFiles) =>
  summarise(
    Object.fromEntries([...libFiles, ...feFiles].map(([f, lines, hits]) => [f, cov(lines, hits)])),
    AREAS,
    areaOf,
    {
      'backend/src/scm/lib': libFiles.map(([f]) => f),
      'frontend/src': feFiles.map(([f]) => f),
    },
  );

test('holding the floor passes; falling below it fails and names the number', () => {
  const s = twoAreaSummary(
    [['backend/src/scm/lib/a.ts', [1, 2, 3, 4], [1, 1, 0, 0]]],
    [['frontend/src/x.tsx', [1, 2], [1, 1]]],
  );
  assert.equal(s.areas[0].pct, 50);

  const held = evaluate(s, { areas: { 'backend/src/scm/lib': { pct: 50, zeroCoverageFiles: 0 }, 'frontend/src': { pct: 100, zeroCoverageFiles: 0 } } });
  assert.equal(held.ok, true);

  const fell = evaluate(s, { areas: { 'backend/src/scm/lib': { pct: 50.01, zeroCoverageFiles: 0 }, 'frontend/src': { pct: 100, zeroCoverageFiles: 0 } } });
  assert.equal(fell.ok, false);
  assert.match(fell.results[0].failures[0], /50\.00%.*floor of 50\.01%/);
});

test('an area with no baseline entry fails rather than passing unmeasured', () => {
  const s = twoAreaSummary([['backend/src/scm/lib/a.ts', [1], [1]]], [['frontend/src/x.tsx', [1], [1]]]);
  const v = evaluate(s, { areas: { 'frontend/src': { pct: 100, zeroCoverageFiles: 0 } } });
  assert.equal(v.ok, false);
  assert.equal(v.results[0].reason, 'no_baseline');
});

test('ONE new untested file fails even though the percentage barely moves', () => {
  // The whole reason the second floor exists. A 4-line untested module dropped
  // into a 1000-line area moves line coverage from 100.00% to 99.60% — a
  // percentage-only ratchet set at 99.5% would wave it through, and the file
  // that carries the money decision would have no test.
  const big = ['backend/src/scm/lib/big.ts', Array.from({ length: 996 }, (_, i) => i + 1), Array.from({ length: 996 }, () => 1)];
  const before = twoAreaSummary([big], [['frontend/src/x.tsx', [1], [1]]]);
  const after = twoAreaSummary([big, ['backend/src/scm/lib/money.ts', [1, 2, 3, 4], [0, 0, 0, 0]]], [['frontend/src/x.tsx', [1], [1]]]);

  assert.equal(before.areas[0].pct, 100);
  assert.equal(after.areas[0].pct, 99.6);
  assert.equal(after.areas[0].zeroCoverageFiles, 1);

  const loosePctFloor = { areas: { 'backend/src/scm/lib': { pct: 99.5, zeroCoverageFiles: 0 }, 'frontend/src': { pct: 100, zeroCoverageFiles: 0 } } };
  const v = evaluate(after, loosePctFloor);
  assert.equal(v.ok, false, 'the no-test floor catches what the percentage floor forgives');
  assert.equal(v.results[0].failures.length, 1);
  assert.match(v.results[0].failures[0], /1 files have NO test executing them, up from 0/);
});

test('a file with zero statements is not counted as an untested file', () => {
  // A pure `export type` module emits nothing. Counting it as "no test" would
  // make the floor un-meetable, and the first un-meetable floor is the last one.
  const s = twoAreaSummary(
    [['backend/src/scm/lib/types.ts', [], []], ['backend/src/scm/lib/a.ts', [1], [1]]],
    [['frontend/src/x.tsx', [1], [1]]],
  );
  assert.equal(s.areas[0].zeroCoverageFiles, 0);
});

// ---------------------------------------------------------------------------
// re-baselining
// ---------------------------------------------------------------------------

test('--update raises a floor but will not lower one without --allow-drop', () => {
  const s = twoAreaSummary([['backend/src/scm/lib/a.ts', [1, 2], [1, 0]]], [['frontend/src/x.tsx', [1], [1]]]);
  assert.equal(s.areas[0].pct, 50);

  const risen = nextBaseline(s, { areas: { 'backend/src/scm/lib': { pct: 20, zeroCoverageFiles: 3 }, 'frontend/src': { pct: 100, zeroCoverageFiles: 0 } } });
  assert.equal(risen.baseline.areas['backend/src/scm/lib'].pct, 49.9);
  assert.equal(risen.baseline.areas['backend/src/scm/lib'].lines.covered, 1, 'the exact measurement is still recorded');
  assert.equal(risen.baseline.areas['backend/src/scm/lib'].zeroCoverageFiles, 0);
  assert.deepEqual(risen.drops, []);

  const held = nextBaseline(s, { areas: { 'backend/src/scm/lib': { pct: 80, zeroCoverageFiles: 0 }, 'frontend/src': { pct: 100, zeroCoverageFiles: 0 } } });
  assert.equal(held.baseline.areas['backend/src/scm/lib'].pct, 80, 'floor held');
  assert.equal(held.drops.length, 1);

  const dropped = nextBaseline(s, { areas: { 'backend/src/scm/lib': { pct: 80, zeroCoverageFiles: 0 }, 'frontend/src': { pct: 100, zeroCoverageFiles: 0 } } }, { allowDrop: true });
  assert.equal(dropped.baseline.areas['backend/src/scm/lib'].pct, 49.9, 'lowered, and only because it was asked for');
});

test('the written floor is the measurement rounded DOWN to one decimal', () => {
  // Slack for the MERGE BASE, not for the author: a PR inherits main's coverage
  // through the merge commit, so a floor pinned to the exact hundredth fails
  // whichever PR runs after someone else merges a few uncovered lines. Bounded,
  // and the zeroCoverageFiles floor — which carries no tolerance at all — is
  // what catches the case that actually matters.
  assert.equal(floorFor(12.73), 12.63);
  assert.equal(floorFor(57.9), 57.8);
  // Subtracting, not rounding down: a measurement already sitting on a tenth
  // would otherwise get a floor equal to itself and no slack at all — which is
  // exactly how backend/scripts (measured 4.20%) failed its own first CI run.
  assert.equal(floorFor(4.2), 4.1);
  assert.equal(floorFor(0.05), 0);
  // A fully covered area gets NO slack: there is no merge-base drift left to
  // absorb, and handing back a line of a complete area should fail.
  assert.equal(floorFor(100), 100);

  const s = twoAreaSummary([['backend/src/scm/lib/a.ts', [1, 2, 3], [1, 0, 0]]], [['frontend/src/x.tsx', [1], [1]]]);
  assert.equal(s.areas[0].pct, 33.33);
  const { baseline: next } = nextBaseline(s, { areas: {} });
  assert.equal(next.areas['backend/src/scm/lib'].pct, 33.23);
  // ...and the tolerance really is only a tenth: a real regression still fails.
  const worse = twoAreaSummary([['backend/src/scm/lib/a.ts', [1, 2, 3, 4], [1, 0, 0, 0]]], [['frontend/src/x.tsx', [1], [1]]]);
  assert.equal(worse.areas[0].pct, 25);
  assert.equal(evaluate(worse, next).ok, false);
});

test('an area with ratchetNoTest:false still MEASURES untested files but does not fail on them', () => {
  // backend/scripts is ~340 one-shot ops scripts, several landing a week, each
  // legitimately untested. A no-test floor there goes red on every ops PR, and
  // a floor that goes red on every PR is a floor somebody deletes. The
  // percentage floor stays, so deleting an existing test still fails.
  const OPS = [{ id: 'ops', dir: 'ops', exts: ['.mjs'], ratchetNoTest: false }];
  const opsAreaOf = (rel) => (rel.startsWith('ops/') ? OPS[0] : null);
  const s = summarise(
    { 'ops/a.mjs': cov([1, 2], [1, 1]), 'ops/new.mjs': cov([1, 2], [0, 0]) },
    OPS,
    opsAreaOf,
    { ops: ['ops/a.mjs', 'ops/new.mjs'] },
  );
  assert.equal(s.areas[0].zeroCoverageFiles, 1, 'still counted and printed');
  assert.equal(s.areas[0].ratchetNoTest, false);
  const v = evaluate(s, { areas: { ops: { pct: 40, zeroCoverageFiles: 0 } } });
  assert.equal(v.ok, true, 'the untested ops script does not fail the gate');

  // ...but the percentage floor in that area is still real.
  assert.equal(evaluate(s, { areas: { ops: { pct: 60, zeroCoverageFiles: 0 } } }).ok, false);
});

test('a re-baseline scoped to one area keeps the other areas floors', () => {
  // --only exists because the backend suite is expensive to instrument and runs
  // on its own schedule. If re-baselining the frontend dropped the backend
  // floors from the file, the next full sweep would have nothing to hold.
  const feOnly = summarise(
    { 'frontend/src/x.tsx': cov([1, 2], [1, 1]) },
    [AREAS[1]],
    (rel) => (rel.startsWith('frontend/src/') ? AREAS[1] : null),
    { 'frontend/src': ['frontend/src/x.tsx'] },
  );
  const prev = { areas: { 'backend/src/scm/lib': { pct: 41.5, zeroCoverageFiles: 9 }, 'frontend/src': { pct: 10, zeroCoverageFiles: 3 } } };
  const { baseline: next } = nextBaseline(feOnly, prev);
  assert.deepEqual(next.areas['backend/src/scm/lib'], { pct: 41.5, zeroCoverageFiles: 9 });
  assert.equal(next.areas['frontend/src'].pct, 100);
});

// ---------------------------------------------------------------------------
// publishing the number
// ---------------------------------------------------------------------------

const BASELINE = { measuredAt: '2026-08-13', areas: { 'frontend/src': { pct: 12.5, zeroCoverageFiles: 400, files: 595, lines: { total: 59834, covered: 7503 } } } };

test('the published table is rendered from the baseline, not typed', () => {
  const table = renderDocTable(BASELINE);
  assert.match(table, /`frontend\/src`/);
  // BOTH numbers: what was measured, and the floor derived from it. Printing
  // only one makes the gate look stricter or looser than it is.
  assert.match(table, /\*\*12\.54%\*\*/, 'the measurement, recomputed from the recorded line counts');
  assert.match(table, /12\.50%/, 'the floor actually enforced');
  assert.match(table, /59834/);
  assert.match(table, /measured 2026-08-13/);
});

test('syncing twice is a fixed point, so --check-docs cannot flap', () => {
  const doc = `# T\n\n${DOC_START}\n(old, wrong numbers)\n${DOC_END}\n\ntail\n`;
  const once = spliceDocTable(doc, renderDocTable(BASELINE));
  const twice = spliceDocTable(once, renderDocTable(BASELINE));
  assert.equal(once, twice);
  assert.doesNotMatch(once, /old, wrong numbers/);
  assert.match(once, /tail/);
});

test('a doc that lost its markers FAILS instead of being silently skipped', () => {
  // A sync that writes nothing is the stale-doc failure wearing a green tick.
  assert.throws(() => spliceDocTable('# T\n\nno markers here\n', 'x'), /markers are missing/);
});

test('VERDICT strings are the ones the CLI prints', () => {
  assert.equal(VERDICT.PASS, 'pass');
  assert.equal(VERDICT.FAIL, 'fail');
});
