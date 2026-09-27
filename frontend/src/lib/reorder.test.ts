import { describe, expect, it } from 'vitest';
import { reorderKeys } from './reorder';

describe('reorderKeys', () => {
  it('moves a key to just before the target', () => {
    expect(reorderKeys(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });
  it('moving to the first target puts it at the front', () => {
    expect(reorderKeys(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });
  it('dropping on itself is a no-op', () => {
    expect(reorderKeys(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
  });
  it('a vanished target leaves the order untouched', () => {
    expect(reorderKeys(['a', 'b', 'c'], 'a', 'zzz')).toEqual(['a', 'b', 'c']);
  });
});
