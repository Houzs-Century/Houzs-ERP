/* One PDF holding many delivery orders becomes one scan each (owner 2026-11-03); a doubtful split keeps the file whole. */
import { describe, expect, test } from 'vitest';
import { planChunks } from './scan-split';

describe('planChunks', () => {
  test('a clean answer covering every page once is used as it is', () => {
    expect(planChunks({ chunks: [{ startPage: 1, endPage: 2 }, { startPage: 3, endPage: 3 }] }, 3)).toEqual([{ startPage: 1, endPage: 2 }, { startPage: 3, endPage: 3 }]);
  });
  test('a gap, an overlap, a missing last page or no answer keeps the whole file', () => {
    const whole = [{ startPage: 1, endPage: 4 }];
    expect(planChunks({ chunks: [{ startPage: 1, endPage: 1 }, { startPage: 3, endPage: 4 }] }, 4)).toEqual(whole);
    expect(planChunks({ chunks: [{ startPage: 1, endPage: 2 }, { startPage: 2, endPage: 4 }] }, 4)).toEqual(whole);
    expect(planChunks({ chunks: [{ startPage: 1, endPage: 3 }] }, 4)).toEqual(whole);
    expect(planChunks(null, 4)).toEqual(whole);
  });
  test('a one-page file is never split', () => {
    expect(planChunks({ chunks: [{ startPage: 1, endPage: 1 }, { startPage: 1, endPage: 1 }] }, 1)).toEqual([{ startPage: 1, endPage: 1 }]);
  });
});
