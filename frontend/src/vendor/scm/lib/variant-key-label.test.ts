/* The one humanisation of a stored variant_key.
 *
 * It exists because a second copy was about to be written: the Stock Transfer
 * picker had humanised the key privately since 2026-07-20, and the two new
 * stock PDFs needed the same rule. `warehouse-label.ts` records what happens
 * when a display rule is hand-copied instead — nine call sites and two
 * different answers for the same warehouse.
 */
import { describe, expect, test } from 'vitest';

import { variantKeyLabel } from './variant-key-label';

describe('variantKeyLabel', () => {
  test('a real key reads as words, not as its storage form', () => {
    expect(variantKeyLabel('fabriccode=bf-16|gap=16|legheight=2', ''))
      .toBe('fabriccode bf-16 · gap 16 · legheight 2');
  });

  test('a single attribute needs no separator', () => {
    expect(variantKeyLabel('fabriccode=bf-16', '')).toBe('fabriccode bf-16');
  });

  /* '' is the plain-SKU bucket — a REAL, pickable value, not a missing one, so
     each surface says so in its own words: the picker offers "(unclassified)",
     a printed cell prints nothing at all. */
  test('the unclassified bucket takes the caller-s word for it', () => {
    expect(variantKeyLabel('', '(unclassified)')).toBe('(unclassified)');
    expect(variantKeyLabel('', '')).toBe('');
  });

  test('null and undefined are the same absence as the empty bucket', () => {
    expect(variantKeyLabel(null, '(none)')).toBe('(none)');
    expect(variantKeyLabel(undefined, '(none)')).toBe('(none)');
    expect(variantKeyLabel('   ', '(none)')).toBe('(none)');
  });

  /* Only the FIRST '=' is a separator: a value may legitimately contain one,
     and eating it would rename the variant. */
  test('an = inside the value survives', () => {
    expect(variantKeyLabel('note=a=b', '')).toBe('note a=b');
  });

  test('a key with no = at all is passed through rather than mangled', () => {
    expect(variantKeyLabel('LEGACY-BUCKET', '')).toBe('LEGACY-BUCKET');
  });
});
