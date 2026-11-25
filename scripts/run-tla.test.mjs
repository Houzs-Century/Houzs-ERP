import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, verdictOf, exitCodeFor } from './run-tla.mjs';

test('parseArgs: cfg only, flag anywhere, explicit tla', () => {
  assert.deepEqual(parseArgs(['a/M.cfg']), { cfg: 'a/M.cfg', tla: null, expectViolation: false });
  assert.deepEqual(parseArgs(['a/B.cfg', '--expect-violation']), { cfg: 'a/B.cfg', tla: null, expectViolation: true });
  assert.deepEqual(parseArgs(['--expect-violation', 'a/B.cfg', 'a/M.tla']), { cfg: 'a/B.cfg', tla: 'a/M.tla', expectViolation: true });
});

test('parseArgs: refuses what it cannot run', () => {
  assert.ok(parseArgs([]).error);
  assert.ok(parseArgs(['a/M.tla']).error);
  assert.ok(parseArgs(['a/M.cfg', 'a/M.txt']).error);
  assert.ok(parseArgs(['--expect', 'a/M.cfg']).error);
});

test('verdictOf reads each TLC ending', () => {
  assert.equal(verdictOf('...\nModel checking completed. No error has been found.\n'), 'pass');
  assert.equal(verdictOf('Error: Invariant NoDoublePost is violated.\nThe behavior up to this point is:'), 'invariant');
  assert.equal(verdictOf('Error: Temporal properties were violated.\n'), 'property');
  assert.equal(verdictOf('Error: Deadlock reached.\n'), 'deadlock');
  assert.equal(verdictOf('***Parse Error***\n'), 'error');
  assert.equal(verdictOf(''), 'error');
});

test('exitCodeFor: only the asked-for verdict is success', () => {
  assert.equal(exitCodeFor('pass', false), 0);
  assert.equal(exitCodeFor('invariant', false), 1);
  assert.equal(exitCodeFor('error', false), 1);
  assert.equal(exitCodeFor('invariant', true), 0);
  assert.equal(exitCodeFor('pass', true), 1);
  assert.equal(exitCodeFor('property', true), 1);
  assert.equal(exitCodeFor('error', true), 1);
});
