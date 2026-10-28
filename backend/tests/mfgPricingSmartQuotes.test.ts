// A variant value must price the same whichever inch mark it was typed with.
//
// THE DEFECT (measured on prod 2026-08-17). Every maintenance-pool lookup
// compares with `===`, so `18"` (U+0022) and `18“` (U+201C — what a phone
// keyboard, or a paste out of Word, produces) are two unrelated keys. 2990's
// live totalHeights pool carries `17“`, `19“`, `25”` and `27“` next to
// straight-quoted `18"` and `26"`, and one document line stores its gap as
// `12“`. A spelling mismatch prices the surcharge at 0 — silently, and
// indistinguishably from a tier that is genuinely free.
//
// THE PROPERTY THAT MATTERS IS NOT "curly matches straight". It is that
// nothing which already matched can change price. Normalisation is a FALLBACK
// after an exact hit, which is what makes this safe on the pools that carry the
// same height twice under different spellings AND different prices (supplier
// 07204b99 has `19“` at both RM40 and RM120). Those tests are the point of this
// file; the happy path is the easy half.

import { describe, it, expect } from 'vitest';
import {
  computeMfgLineCost,
  normaliseTypographicQuotes,
  type MaintenanceConfig,
  type MfgPricedOption,
} from '../src/scm/shared/mfg-pricing';

const config = (totalHeights: MfgPricedOption[]): MaintenanceConfig => ({
  divanHeights: [], legHeights: [], totalHeights,
  gaps: [], specials: [], sofaLegHeights: [], sofaSpecials: [], sofaSizes: [],
});

const costOf = (totalHeight: string, pool: MfgPricedOption[]) => computeMfgLineCost(
  {
    product: { category: 'BEDFRAME', basePriceSen: 40000 },
    qty: 1,
    totalHeight,
  },
  config(pool),
).totalHeightSurchargeSen;

describe('normaliseTypographicQuotes', () => {
  it('folds every curly double form onto the ASCII inch mark', () => {
    for (const q of ['“', '”', '„', '‟', '″', 'ʺ']) {
      expect(normaliseTypographicQuotes(`18${q}`)).toBe('18"');
    }
  });

  it('folds the curly single forms onto the ASCII foot mark', () => {
    for (const q of ['‘', '’', '‚', '‛', '′', 'ʹ']) {
      expect(normaliseTypographicQuotes(`5${q}`)).toBe("5'");
    }
  });

  it('leaves everything else alone — no trim, no case folding', () => {
    expect(normaliseTypographicQuotes('  18" HB Fully Cover ')).toBe('  18" HB Fully Cover ');
  });
});

describe('surcharge lookup across quote spellings', () => {
  const straightPool: MfgPricedOption[] = [{ value: '18"', priceSen: 8000 }];
  const curlyPool: MfgPricedOption[] = [{ value: '17“', priceSen: 12000 }];

  it('prices a curly document value against a straight pool entry', () => {
    // Was 0 before this change — the shape that lost the surcharge silently.
    expect(costOf('18“', straightPool)).toBe(8000);
  });

  it('prices a straight document value against a curly pool entry', () => {
    // 2990's real pool: `17“` is stored curly, so a straight `17"` found nothing.
    expect(costOf('17"', curlyPool)).toBe(12000);
  });

  it('still prices an exact match exactly', () => {
    expect(costOf('18"', straightPool)).toBe(8000);
    expect(costOf('17“', curlyPool)).toBe(12000);
  });

  it('gives an unknown height 0, as before', () => {
    expect(costOf('40"', straightPool)).toBe(0);
  });
});

describe('a pool holding the same height under two spellings', () => {
  /* Supplier 07204b99's live pool, reduced: 19 inches appears twice, curly at
     RM120 and straight at RM40. Exact-first is what keeps each document on the
     price it resolves to TODAY; a normalise-only lookup would collapse both
     onto whichever entry sorts first and silently re-price one of them. */
  const collidingPool: MfgPricedOption[] = [
    { value: '19“', priceSen: 12000 },
    { value: '19"', priceSen: 4000 },
  ];

  it('keeps a curly line on the curly entry', () => {
    expect(costOf('19“', collidingPool)).toBe(12000);
  });

  it('keeps a straight line on the straight entry', () => {
    expect(costOf('19"', collidingPool)).toBe(4000);
  });

  it('falls back to the first entry only for a spelling neither matches', () => {
    // U+2033 DOUBLE PRIME matches neither exactly; it normalises to `19"` and
    // takes the first entry that also normalises to `19"` — the curly one.
    // Documented rather than desirable: the real fix is removing the duplicate,
    // which needs a human to say which price is right.
    expect(costOf('19″', collidingPool)).toBe(12000);
  });
});
