import { describe, expect, it } from 'vitest';
import { mergeShownOrder, orderComparator } from './delivery-row-order';

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

describe('mergeShownOrder', () => {
  const live = (...k: string[]) => new Set(k);
  it('a drag in a filtered view keeps the hidden rows in their places (HC-0224)', () => {
    // x is hidden by a funnel; the shown rows a,b,c are re-ordered c,a,b.
    expect(mergeShownOrder(['a', 'x', 'b'], ['c', 'a', 'b'], live('a', 'b', 'c', 'x'))).toEqual(['c', 'x', 'a', 'b']);
  });
  it('drops saved keys that are no longer loaded', () => {
    expect(mergeShownOrder(['gone', 'a', 'b'], ['b', 'a'], live('a', 'b'))).toEqual(['b', 'a']);
  });
  it('with nothing saved it is the shown order', () => {
    expect(mergeShownOrder([], ['b', 'a'], live('a', 'b'))).toEqual(['b', 'a']);
  });
});
