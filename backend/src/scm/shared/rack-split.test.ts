import { describe, expect, it } from 'vitest';
import {
  addToRackSplit, effectiveRackSplit, MAX_RACK_SPLITS, rackSplitError, rackSplitPostError,
  rackSplitRemaining, removeFromRackSplit,
} from './rack-split';

describe('rack split rule', () => {
  it('lets a draft hold part of the goods, never more than accepted', () => {
    expect(rackSplitError(10, [{ rackId: 'A', qty: 6 }])).toBeNull();
    expect(rackSplitError(10, [{ rackId: 'A', qty: 6 }, { rackId: 'B', qty: 5 }])).toBe('The racks hold 11 but only 10 were accepted.');
    expect(rackSplitRemaining(10, [{ rackId: 'A', qty: 6 }])).toBe(4);
  });

  it('refuses a repeated rack, a blank rack and a non-whole or non-positive qty', () => {
    expect(rackSplitError(10, [{ rackId: 'A', qty: 1 }, { rackId: 'A', qty: 1 }])).toMatch(/twice/);
    expect(rackSplitError(10, [{ rackId: '', qty: 1 }])).toMatch(/Pick a rack/);
    expect(rackSplitError(10, [{ rackId: 'A', qty: 1.5 }])).toMatch(/whole quantity/);
    expect(rackSplitError(10, [{ rackId: 'A', qty: 0 }])).toMatch(/whole quantity/);
    const many = Array.from({ length: MAX_RACK_SPLITS + 1 }, (_, i) => ({ rackId: `R${i}`, qty: 1 }));
    expect(rackSplitError(100, many)).toMatch(/at most/);
  });

  it('posts only a split that accounts for every accepted unit, or no split at all', () => {
    expect(rackSplitPostError(10, [])).toBeNull();
    expect(rackSplitPostError(10, [{ rackId: 'A', qty: 6 }, { rackId: 'B', qty: 4 }])).toBeNull();
    expect(rackSplitPostError(10, [{ rackId: 'A', qty: 6 }])).toBe('The racks hold 6 of the 10 accepted.');
  });

  it('merges a second scan of the same rack and removes by rack', () => {
    const s = addToRackSplit(addToRackSplit([], 'A', 2), 'A', 3);
    expect(s).toEqual([{ rackId: 'A', qty: 5 }]);
    expect(removeFromRackSplit(addToRackSplit(s, 'B', 1), 'A')).toEqual([{ rackId: 'B', qty: 1 }]);
  });

  it('reads a one-rack line as that rack holding everything accepted', () => {
    expect(effectiveRackSplit('A', 10, [])).toEqual([{ rackId: 'A', qty: 10 }]);
    expect(effectiveRackSplit('A', 10, [{ rackId: 'B', qty: 3 }])).toEqual([{ rackId: 'B', qty: 3 }]);
    expect(effectiveRackSplit(null, 10, [])).toEqual([]);
  });
});
