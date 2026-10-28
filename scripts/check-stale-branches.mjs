// Tests for the stale-branch report's classification (scripts/lib/stale-branches.mjs).
//
// RUN IT WITH (from the repo root):
//   node --test scripts/check-stale-branches.mjs
//
// NO DEPENDENCIES, on purpose — node:test and node:assert are built in.
//
// The properties worth pinning are the ones that decide whether a human loses
// work: a branch with no PR is never called safe to delete, an open PR is never
// called stale, and a branch reopened under a second PR is aged from the LATEST
// closure rather than the first.
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyBranches, formatReport, PROTECTED_BRANCHES } from './lib/stale-branches.mjs';

const NOW = new Date('2026-08-13T00:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

test('a PR closed longer ago than the threshold is stale', () => {
  const r = classifyBranches({
    branches: ['old'],
    pulls: [{ number: 1, state: 'closed', merged_at: null, closed_at: daysAgo(45), head_ref: 'old' }],
    now: NOW,
  });
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].days, 45);
  assert.equal(r.stale[0].merged, false);
});

test('a PR closed inside the threshold is NOT stale', () => {
  const r = classifyBranches({
    branches: ['fresh'],
    pulls: [{ number: 2, state: 'closed', merged_at: daysAgo(3), closed_at: daysAgo(3), head_ref: 'fresh' }],
    now: NOW,
  });
  assert.equal(r.stale.length, 0);
  assert.equal(r.recentlyClosed.length, 1);
  assert.equal(r.recentlyClosed[0].merged, true);
});

test('an open PR is never stale, however old', () => {
  const r = classifyBranches({
    branches: ['live'],
    pulls: [{ number: 3, state: 'open', merged_at: null, closed_at: null, head_ref: 'live' }],
    now: NOW,
  });
  assert.equal(r.stale.length, 0);
  assert.equal(r.openPr.length, 1);
});

test('a branch with NO pull request is never reported as safe to delete', () => {
  const r = classifyBranches({ branches: ['orphan'], pulls: [], now: NOW });
  assert.equal(r.stale.length, 0);
  assert.deepEqual(r.noPr, [{ branch: 'orphan' }]);
  const md = formatReport(r, { totalBranches: 1 });
  assert.match(md, /NO pull request/);
  assert.match(md, /ask the author/);
});

test('a branch reopened under a newer PR ages from the LATEST closure', () => {
  const r = classifyBranches({
    branches: ['revived'],
    pulls: [
      { number: 10, state: 'closed', merged_at: null, closed_at: daysAgo(200), head_ref: 'revived' },
      { number: 11, state: 'closed', merged_at: daysAgo(2), closed_at: daysAgo(2), head_ref: 'revived' },
    ],
    now: NOW,
  });
  assert.equal(r.stale.length, 0, 'the 200-day-old first PR must not make it stale');
  assert.equal(r.recentlyClosed[0].days, 2);
});

test('an open PR wins even when an older PR on the same branch is closed', () => {
  const r = classifyBranches({
    branches: ['b'],
    pulls: [
      { number: 20, state: 'closed', merged_at: null, closed_at: daysAgo(100), head_ref: 'b' },
      { number: 21, state: 'open', merged_at: null, closed_at: null, head_ref: 'b' },
    ],
    now: NOW,
  });
  assert.equal(r.openPr.length, 1);
  assert.equal(r.stale.length, 0);
});

test('main and staging are protected and never appear as candidates', () => {
  assert.ok(PROTECTED_BRANCHES.has('main'));
  assert.ok(PROTECTED_BRANCHES.has('staging'));
  const r = classifyBranches({ branches: ['main', 'staging'], pulls: [], now: NOW });
  assert.equal(r.stale.length, 0);
  assert.equal(r.noPr.length, 0);
  assert.deepEqual(r.protectedBranches, ['main', 'staging']);
});

test('the report states plainly that it deletes nothing', () => {
  const r = classifyBranches({
    branches: ['old'],
    pulls: [{ number: 1, state: 'closed', merged_at: null, closed_at: daysAgo(45), head_ref: 'old' }],
    now: NOW,
  });
  const md = formatReport(r, { totalBranches: 1 });
  assert.match(md, /never deletes anything/);
});
