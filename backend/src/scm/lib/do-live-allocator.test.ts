import { describe, it, expect } from 'vitest';
import { pickIncomingForBucket, pickIncomingForSofaSet, type IncomingLine } from './do-live-allocator';

const line = (po: string, code: string, key: string, qty: number, eta: string | null): IncomingLine =>
  ({ poNumber: po, itemCode: code, variantKey: key, warehouseId: 'wh-1', qtyLeft: qty, eta });

describe('pickIncomingForBucket — the owner\'s supply-side order', () => {
  it('earliest effective ETA wins', () => {
    const pick = pickIncomingForBucket([
      line('PO-2', 'X', 'k', 1, '2026-08-20'),
      line('PO-1', 'X', 'k', 1, '2026-08-25'),
    ], 'X', 'k', 1);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('equal ETA -> the smaller PO number ("SO1 比 SO2 优先", supply mirror)', () => {
    const pick = pickIncomingForBucket([
      line('PO-9', 'X', 'k', 1, '2026-08-20'),
      line('PO-2', 'X', 'k', 1, '2026-08-20'),
    ], 'X', 'k', 1);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('an undated promise never outranks a dated one', () => {
    const pick = pickIncomingForBucket([
      line('PO-1', 'X', 'k', 5, null),
      line('PO-2', 'X', 'k', 5, '2026-09-01'),
    ], 'X', 'k', 1);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('prefers the first PO that COVERS the need over an earlier partial', () => {
    const pick = pickIncomingForBucket([
      line('PO-1', 'X', 'k', 1, '2026-08-10'),
      line('PO-2', 'X', 'k', 3, '2026-08-15'),
    ], 'X', 'k', 2);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('falls back to the earliest partial when nothing covers alone', () => {
    const pick = pickIncomingForBucket([
      line('PO-1', 'X', 'k', 1, '2026-08-10'),
      line('PO-2', 'X', 'k', 1, '2026-08-15'),
    ], 'X', 'k', 3);
    expect(pick?.poNumber).toBe('PO-1');
  });

  it('aggregates several lines of the same PO before judging cover', () => {
    const pick = pickIncomingForBucket([
      line('PO-1', 'X', 'k', 1, '2026-08-10'),
      line('PO-1', 'X', 'k', 1, '2026-08-12'),
    ], 'X', 'k', 2);
    expect(pick?.poNumber).toBe('PO-1');
    expect(pick?.qtyLeft).toBe(2);
  });

  it('ignores other buckets and empty lines; null when the pool is empty', () => {
    expect(pickIncomingForBucket([line('PO-1', 'X', 'other', 5, null)], 'X', 'k', 1)).toBeNull();
    expect(pickIncomingForBucket([line('PO-1', 'X', 'k', 0, null)], 'X', 'k', 1)).toBeNull();
  });
});

describe('pickIncomingForSofaSet — one dye lot per set, sofa only', () => {
  const needs = new Map([['A::k1', 1], ['B::k2', 1]]);

  it('picks the single PO that covers the whole set', () => {
    const pick = pickIncomingForSofaSet([
      line('PO-1', 'A', 'k1', 1, '2026-08-10'), // covers only half
      line('PO-2', 'A', 'k1', 1, '2026-08-20'),
      line('PO-2', 'B', 'k2', 1, '2026-08-20'),
    ], needs);
    expect(pick?.poNumber).toBe('PO-2');
  });

  it('among full covers: earliest ETA, then smaller PO number', () => {
    const both = (po: string, eta: string) => [line(po, 'A', 'k1', 1, eta), line(po, 'B', 'k2', 1, eta)];
    expect(pickIncomingForSofaSet([...both('PO-5', '2026-08-20'), ...both('PO-3', '2026-08-15')], needs)?.poNumber).toBe('PO-3');
    expect(pickIncomingForSofaSet([...both('PO-5', '2026-08-20'), ...both('PO-3', '2026-08-20')], needs)?.poNumber).toBe('PO-3');
  });

  it('null when no single PO covers the set — the conflict path takes over', () => {
    const pick = pickIncomingForSofaSet([
      line('PO-1', 'A', 'k1', 1, '2026-08-10'),
      line('PO-2', 'B', 'k2', 1, '2026-08-10'),
    ], needs);
    expect(pick).toBeNull();
  });

  it('set membership needs no READY state — needs come straight from the lines (closes the empty-full-set gap)', () => {
    // A set whose SO lines are nowhere READY still forms a complete needs map here.
    const pick = pickIncomingForSofaSet([
      line('PO-7', 'A', 'k1', 2, '2026-09-01'),
      line('PO-7', 'B', 'k2', 2, '2026-09-01'),
    ], new Map([['A::k1', 2], ['B::k2', 2]]));
    expect(pick?.poNumber).toBe('PO-7');
  });
});
