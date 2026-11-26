import { describe, it, expect } from 'vitest';
import { allocateBucketCost } from './bucket-cost-allocation';


const sum = (m: Map<string, { lineCostSen: number }>) =>
  [...m.values()].reduce((s, v) => s + v.lineCostSen, 0);

describe('allocateBucketCost — the shares always sum to the bucket', () => {
  it('a sub-sen unit cost no longer INVENTS money (B5, the doubling direction)', () => {
    const got = allocateBucketCost([{ id: 'a', qty: 100 }], 50);
    expect(sum(got)).toBe(50);
    expect(got.get('a')!.lineCostSen).toBe(50);
  });

  it('a sub-sen unit cost no longer DESTROYS money (the quieter direction)', () => {
    const got = allocateBucketCost([{ id: 'a', qty: 100 }], 40);
    expect(sum(got)).toBe(40);
    expect(got.get('a')!.lineCostSen).toBe(40);
  });

  it('splits across lines and the remainder lands on the last one', () => {
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
    const got = allocateBucketCost([{ id: 'a', qty: 3 }], 10);
    expect(got.get('a')!.lineCostSen).toBe(10);
    expect(got.get('a')!.unitCostSen).toBe(3);
  });
});
