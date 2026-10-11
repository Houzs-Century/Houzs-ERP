import { describe, expect, test } from 'vitest';
import { soReleasedForDemand as tsGate } from '../src/scm/shared/mrp-demand-gate';
// @ts-expect-error - plain .mjs mirror for audit scripts
import { soReleasedForDemand as jsGate } from '../scripts/lib/mrp-demand-gate.mjs';

/* Owner 2026-09-15: 「没有 Processing date 的单子就不进来」. The engine and the
   stored allocator read the TS rule; the .mjs replicas of the engine read the
   mirror. This is the pin that keeps them one rule. */

const CASES: Array<[unknown, boolean]> = [
  [null, false],
  [undefined, false],
  ['', false],
  ['   ', false],
  ['2026-09-15', true],
  ['2026-09-15T00:00:00+08:00', true],
  [new Date('2026-09-15'), true],
  [new Date('not a date'), false],
];

describe('soReleasedForDemand — an order with no processing date is not demand', () => {
  test.each(CASES)('%s -> %s', (value, expected) => {
    expect(tsGate(value)).toBe(expected);
  });
});

describe('mrp-demand-gate.mjs mirrors mrp-demand-gate.ts', () => {
  test.each(CASES)('%s answers the same on both sides', (value) => {
    expect(jsGate(value)).toBe(tsGate(value));
  });
});
