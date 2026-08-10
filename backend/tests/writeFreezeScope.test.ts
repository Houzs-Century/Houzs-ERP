// The freeze is PER COMPANY (owner 2026-08-10: "是 Houzs company 而已, 2990
// remain"). A regression here stops a business that has no reason to stop, so
// the value parsing is pinned.
import { describe, it, expect } from 'vitest';
import { parseFreezeValue } from '../src/scm/lib/write-freeze';

describe('write-freeze value parsing', () => {
  it('treats absent / off / falsey as open', () => {
    for (const v of [null, undefined, '', '  ', 'off', '0', 'false']) {
      expect(parseFreezeValue(v)).toBe('off');
    }
  });

  it("freezes every company only on 'all'", () => {
    expect(parseFreezeValue('all')).toBe('all');
    expect(parseFreezeValue('ALL')).toBe('all');
  });

  it('freezes the listed companies only', () => {
    expect(parseFreezeValue('1')).toEqual([1]);
    expect(parseFreezeValue('1,3')).toEqual([1, 3]);
    expect(parseFreezeValue(' 1 , 3 ')).toEqual([1, 3]);
  });

  it('company 1 frozen leaves company 2 (2990) open', () => {
    const scope = parseFreezeValue('1');
    expect(Array.isArray(scope) && scope.includes(1)).toBe(true);
    expect(Array.isArray(scope) && scope.includes(2)).toBe(false);
  });

  it('garbage is open, never a silent all-freeze', () => {
    expect(parseFreezeValue('yes please')).toBe('off');
  });
});
