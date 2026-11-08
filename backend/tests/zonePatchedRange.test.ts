import { describe, expect, it } from 'vitest';
import { patchedPrefixRange } from '../src/scm/lib/zone-classify';

describe('patchedPrefixRange (PATCH /delivery-zones/:id range guard)', () => {
  const stored = { prefixStart: 46, prefixEnd: 47 };
  it('checks a one-ended edit against the stored other end', () => {
    expect(patchedPrefixRange(stored, { prefixStart: 50 })).toBeNull();
    expect(patchedPrefixRange(stored, { prefixEnd: 40 })).toBeNull();
    expect(patchedPrefixRange(stored, { prefixStart: 47 })).toEqual({ prefixStart: 47, prefixEnd: 47 });
  });
  it('checks a two-ended edit on its own', () => {
    expect(patchedPrefixRange(stored, { prefixStart: 60, prefixEnd: 50 })).toBeNull();
    expect(patchedPrefixRange(stored, { prefixStart: 50, prefixEnd: 60 })).toEqual({ prefixStart: 50, prefixEnd: 60 });
  });
  it('keeps the stored range when the edit sends neither end', () => {
    expect(patchedPrefixRange(stored, {})).toEqual(stored);
  });
});
