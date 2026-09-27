import { describe, expect, it } from 'vitest';
import { orderComparator } from './delivery-row-order';

describe('orderComparator', () => {
  const by = (order: string[], keys: string[]) => [...keys].sort(orderComparator(order));

  it('sorts listed keys into the manual order', () => {
    expect(by(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });
  it('keeps unlisted keys after the listed ones, in their input order', () => {
    // b,d unlisted → after a,c (a before c per the order), keeping b before d.
    expect(by(['a', 'c'], ['b', 'a', 'd', 'c'])).toEqual(['a', 'c', 'b', 'd']);
  });
  it('an empty order leaves everything in its natural order', () => {
    expect(by([], ['x', 'y', 'z'])).toEqual(['x', 'y', 'z']);
  });
});
