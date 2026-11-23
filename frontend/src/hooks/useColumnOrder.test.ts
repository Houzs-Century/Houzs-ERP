import { describe, expect, it } from 'vitest';
import { moveColumn, normalizeColumnOrder } from './useColumnOrder';

const DEFAULT_KEYS = ['sku', 'name', 'variant', 'counted'] as const;

describe('moveColumn', () => {
  it('moves a column right onto the last slot', () => {
    expect(moveColumn(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });
  it('moves a column left onto the first slot', () => {
    expect(moveColumn(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });
  it('leaves the order alone for an unknown key', () => {
    expect(moveColumn(['a', 'b', 'c'], 'a', 'z')).toEqual(['a', 'b', 'c']);
  });
});

describe('normalizeColumnOrder', () => {
  it('keeps a valid saved order', () => {
    expect(normalizeColumnOrder(['counted', 'sku', 'name', 'variant'], DEFAULT_KEYS))
      .toEqual(['counted', 'sku', 'name', 'variant']);
  });
  it('drops unknown and duplicate keys and restores missing ones at their default slot', () => {
    expect(normalizeColumnOrder(['name', 'gone', 'name', 'counted'], DEFAULT_KEYS))
      .toEqual(['sku', 'name', 'variant', 'counted']);
  });
  it('falls back to the default order for a value that is not a list', () => {
    expect(normalizeColumnOrder({ broken: true }, DEFAULT_KEYS)).toEqual([...DEFAULT_KEYS]);
  });
});
