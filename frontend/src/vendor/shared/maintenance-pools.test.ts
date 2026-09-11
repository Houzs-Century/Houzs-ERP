// The pool restrict step, which had no test while it silently hid options the
// Model plainly listed.
//
// The values below are the REAL production pools, measured 2026-09-11 on
// company 1: `gaps` holds ten curly-spelled inch marks and `total_heights` six,
// across 10 bedframe Models, while the editors emit U+0022. So Gap 11 through
// 20 inch were invisible in the picker on BOTH desktop and mobile, and the
// SERVER would have accepted every one of them. docs/bugs/0814.
import { describe, expect, it } from 'vitest';

import { restrictPricedToPool, restrictStringsToPool } from './maintenance-pools';

/** Verbatim from production: scm.product_models.allowed_options.gaps. */
const PROD_GAPS_POOL = [
  '4"', '5"', '6"', '7"', '8"', '9"', '10"',
  '11”', '12“', '13”', '14“', '15”', '16“',
  '17”', '18“', '19”', '20“',
];
/** What the editor emits for the same values (SoLineCard: `${d + l + g}"`). */
const EDITOR_GAPS = ['4"', '8"', '11"', '15"', '20"'];

describe('restrictStringsToPool — typographic quotes', () => {
  it('keeps an ASCII option whose pool entry is spelled curly (the reported bug)', () => {
    expect(restrictStringsToPool(EDITOR_GAPS, PROD_GAPS_POOL)).toEqual(EDITOR_GAPS);
  });

  it('before folding, the raw comparison dropped exactly the curly ones', () => {
    // The old behaviour, kept as an executable record of what was wrong: three
    // of five options vanished from a pool that lists all five.
    const raw = EDITOR_GAPS.filter((o) => PROD_GAPS_POOL.includes(o));
    expect(raw).toEqual(['4"', '8"']);
  });

  it('keeps a CURLY option whose pool entry is ASCII — it folds both sides', () => {
    expect(restrictStringsToPool(['11”'], ['11"'])).toEqual(['11”']);
  });

  it('folds the GLYPH only — never the number, so no pool gains a value', () => {
    expect(restrictStringsToPool(['12"', '21"'], PROD_GAPS_POOL)).toEqual(['12"']);
    expect(restrictStringsToPool(['No Leg'], ['1"', '2"'])).toEqual([]);
  });

  it('an empty or absent pool still offers everything', () => {
    expect(restrictStringsToPool(EDITOR_GAPS, [])).toEqual(EDITOR_GAPS);
    expect(restrictStringsToPool(EDITOR_GAPS, null)).toEqual(EDITOR_GAPS);
    expect(restrictStringsToPool(EDITOR_GAPS, undefined)).toEqual(EDITOR_GAPS);
  });

  it('still grandfathers a saved off-pool value passed as keep', () => {
    expect(restrictStringsToPool(['99"'], PROD_GAPS_POOL, '99"')).toEqual(['99"']);
    expect(restrictStringsToPool(['99"'], PROD_GAPS_POOL)).toEqual([]);
  });

  it('does not mutate the arrays it is given', () => {
    const opts = [...EDITOR_GAPS];
    const pool = [...PROD_GAPS_POOL];
    restrictStringsToPool(opts, pool);
    expect(opts).toEqual(EDITOR_GAPS);
    expect(pool).toEqual(PROD_GAPS_POOL);
  });

  it('trims, because a pool typed by a person carries stray spaces', () => {
    expect(restrictStringsToPool(['11"'], [' 11” '])).toEqual(['11"']);
  });
});

describe('restrictPricedToPool — the same rule for priced options', () => {
  const opts = [
    { value: '11"', priceSen: 0 },
    { value: '15"', priceSen: 5000 },
    { value: '99"', priceSen: 0 },
  ];

  it('keeps the curly-listed values and drops what the pool does not list', () => {
    expect(restrictPricedToPool(opts, PROD_GAPS_POOL).map((o) => o.value)).toEqual(['11"', '15"']);
  });

  it('carries the price through untouched', () => {
    expect(restrictPricedToPool(opts, PROD_GAPS_POOL)).toEqual([
      { value: '11"', priceSen: 0 },
      { value: '15"', priceSen: 5000 },
    ]);
  });

  it('keeps a saved off-pool value when asked', () => {
    expect(restrictPricedToPool(opts, PROD_GAPS_POOL, '99"').map((o) => o.value))
      .toEqual(['11"', '15"', '99"']);
  });

  it('an empty pool offers everything', () => {
    expect(restrictPricedToPool(opts, [])).toEqual(opts);
  });
});
