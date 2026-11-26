import { describe, expect, test } from 'vitest';

import { variantKeyLabel, variantWords } from './variant-key-label';

describe('variantKeyLabel', () => {
  test('a real key reads as words, not as its storage form', () => {
    expect(variantKeyLabel('fabriccode=bf-16|gap=16|legheight=2', ''))
      .toBe('fabriccode bf-16 · gap 16 · legheight 2');
  });

  test('a single attribute needs no separator', () => {
    expect(variantKeyLabel('fabriccode=bf-16', '')).toBe('fabriccode bf-16');
  });

  test('the unclassified bucket takes the caller-s word for it', () => {
    expect(variantKeyLabel('', '(unclassified)')).toBe('(unclassified)');
    expect(variantKeyLabel('', '')).toBe('');
  });

  test('null and undefined are the same absence as the empty bucket', () => {
    expect(variantKeyLabel(null, '(none)')).toBe('(none)');
    expect(variantKeyLabel(undefined, '(none)')).toBe('(none)');
    expect(variantKeyLabel('   ', '(none)')).toBe('(none)');
  });

  test('an = inside the value survives', () => {
    expect(variantKeyLabel('note=a=b', '')).toBe('note a=b');
  });

  test('a key with no = at all is passed through rather than mangled', () => {
    expect(variantKeyLabel('LEGACY-BUCKET', '')).toBe('LEGACY-BUCKET');
  });
});

describe('variantWords', () => {
  test('reads a stored key in plain words', () => {
    expect(variantWords('fabriccode=bf-17|gap=15"|divanheight=8"|legheight=1"')).toBe('bf-17 · gap 15" · divan 8" · leg 1"');
  });
  test('an unclassified item has no words', () => {
    expect(variantWords('')).toBe('');
  });
});
