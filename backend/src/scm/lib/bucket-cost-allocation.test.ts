import { describe, it, expect } from 'vitest';
import { allocateBucketCost } from './bucket-cost-allocation';

/*
 * The property that matters is the FIRST assertion in every case below: the
 * shares sum to the bucket exactly. Everything else is secondary — a line being
 * one sen off its proportional share is arithmetic; the column not summing to
 * what was booked is money appearing or disappearing.
 *
 * The two headline cases reproduce the defect this replaces, which is ledger B5
 * in its second home: `round(bucket / qty) * line_qty`.
 */

const sum = (m: Map<string, { lineCostSen: number }>) =>
  [...m.values()].reduce((s, v) => s + v.lineCostSen, 0);

describe('allocateBucketCost — the shares always sum to the bucket', () => {
  it('a sub-sen unit cost no longer INVENTS money (B5, the doubling direction)', () => {
    // 50 sen over 100 units. The old code did round(50/100) = round(0.5) = 1,
    // then 1 x 100 = 100 sen — twice what was booked.
    const got = allocateBucketCost([{ id: 'a', qty: 100 }], 50);
    expect(sum(got)).toBe(50);
    expect(got.get('a')!.lineCostSen).toBe(50);
  });

  it('a sub-sen unit cost no longer DESTROYS money (the quieter direction)', () => {
    // 40 sen over 100 units. round(0.4) = 0, then 0 x 100 = 0 — the whole cost
    // gone, and nothing anywhere says so.
    const got = allocateBucketCost([{ id: 'a', qty: 100 }], 40);
    expect(sum(got)).toBe(40);
    expect(got.get('a')!.lineCostSen).toBe(40);
  });

  it('splits across lines and the remainder lands on the last one', () => {
    // 100 sen over three equal lines: 33 + 33 + 34. Rounding each independently
    // gives 33 + 33 + 33 = 99 and loses a sen.
    const got = allocateBucketCost(
      [{ id: 'a', qty: 1 }, { id: 'b', qty: 1 }, { id: 'c', qty: 1 }], 100,
    );
    expect(sum(got)).toBe(100);
    expect(got.get('c')!.lineCostSen).toBe(34);
  });

  it('splits by QUANTITY, not per line', () => {
    const got = allocateBucketCost([{ id: 'a', qty: 1 }, { id: 'b', qty: 3 }], 400);
    expect(sum(got)).toBe(400);
    expect(got.get('a')!.lineCostSen).toBe(100);
    expect(got.get('b')!.lineCostSen).toBe(300);
  });

  it('an exact whole-sen split is unchanged — the common case must not move', () => {
    const got = allocateBucketCost([{ id: 'a', qty: 2 }, { id: 'b', qty: 2 }], 1000);
    expect(sum(got)).toBe(1000);
    expect(got.get('a')!.lineCostSen).toBe(500);
    expect(got.get('a')!.unitCostSen).toBe(250);
  });

  it('a line with no quantity gets nothing, and does not eat the remainder', () => {
    const got = allocateBucketCost([{ id: 'a', qty: 0 }, { id: 'b', qty: 5 }], 999);
    expect(sum(got)).toBe(999);
    expect(got.get('a')!.lineCostSen).toBe(0);
    expect(got.get('b')!.lineCostSen).toBe(999);
  });

  it('a bucket with no quantity anywhere allocates nothing rather than inventing a basis', () => {
    const got = allocateBucketCost([{ id: 'a', qty: 0 }], 500);
    expect(sum(got)).toBe(0);
  });

  it('zero cost stays zero across many lines', () => {
    const got = allocateBucketCost([{ id: 'a', qty: 7 }, { id: 'b', qty: 3 }], 0);
    expect(sum(got)).toBe(0);
  });

  it('the unit cost is DERIVED from the share, and may round — the share does not', () => {
    // 10 sen over 3 units: unit rounds to 3, but the line keeps all 10.
    const got = allocateBucketCost([{ id: 'a', qty: 3 }], 10);
    expect(got.get('a')!.lineCostSen).toBe(10);
    expect(got.get('a')!.unitCostSen).toBe(3);
  });
});
