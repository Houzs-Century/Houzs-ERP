import { describe, it, expect } from 'vitest';
import { isFocLine, isFreeGiftLine, focLineCount } from './foc-line';

describe('isFocLine', () => {
  it('charges nothing per unit and nothing in total — free', () => {
    expect(isFocLine({ unit_price_sen: 0, line_total_sen: 0 })).toBe(true);
    expect(isFocLine({ unitPriceSen: 0, lineTotalSen: 0 })).toBe(true);
    expect(isFocLine({ unit_price_sen: 0, total_sen: 0 })).toBe(true);
  });

  it('an ABSENT price counts as zero — the two surfaces that disagreed now agree', () => {
    expect(isFocLine({ unit_price_sen: null, line_total_sen: 0 })).toBe(true);
    expect(isFocLine({})).toBe(true);
  });

  it('priced at zero but STILL TAKING MONEY is not free — the delivery order was missing this half', () => {
    expect(isFocLine({ unit_price_sen: 0, line_total_sen: 15_000 })).toBe(false);
  });

  it('a normal sold line is not free', () => {
    expect(isFocLine({ unit_price_sen: 25_000, line_total_sen: 25_000 })).toBe(false);
  });

  it('discounted to zero is NOT free — it was sold and then given away, and the discount is the story', () => {
    expect(isFocLine({ unit_price_sen: 10_000, line_total_sen: 0 })).toBe(false);
  });

  it('a promotional gift is free whatever the numbers say', () => {
    expect(isFocLine({ unit_price_sen: 25_000, line_total_sen: 25_000, variants: { freeGift: true } })).toBe(true);
    expect(isFocLine({ unit_price_sen: 25_000, line_total_sen: 25_000, variants: { freeGift: 'SOFA-PILLOW' } })).toBe(true);
  });

  it('an empty or false gift marker is not a gift', () => {
    expect(isFreeGiftLine({ variants: { freeGift: false } })).toBe(false);
    expect(isFreeGiftLine({ variants: { freeGift: '' } })).toBe(false);
    expect(isFreeGiftLine({ variants: {} })).toBe(false);
    expect(isFreeGiftLine({ variants: null })).toBe(false);
  });

  it('the line total is read from whichever column the document calls it', () => {
    expect(isFocLine({ unit_price_sen: 0, total_sen: 25_000 })).toBe(false);
    expect(isFocLine({ unit_price_sen: 0, line_total_sen: 25_000 })).toBe(false);
  });
});

describe('focLineCount', () => {
  it('counts the free lines so the badge and the footnote cannot disagree', () => {
    expect(focLineCount([
      { unit_price_sen: 0, line_total_sen: 0 },
      { unit_price_sen: 25_000, line_total_sen: 25_000 },
      { unit_price_sen: 0, line_total_sen: 15_000 },
      { unit_price_sen: 9_900, line_total_sen: 9_900, variants: { freeGift: true } },
    ])).toBe(2);
  });

  it('an empty document has none', () => {
    expect(focLineCount([])).toBe(0);
  });
});
