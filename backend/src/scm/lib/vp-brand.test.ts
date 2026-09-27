import { describe, it, expect } from 'vitest';
import { NOT_A_BRAND, vpBrandOptions, matchVpBrand, vpBrandAsk } from './vp-brand';

/* ---------------------------------------------------------------------------
 * The brand list is Houzs Century's project_brands as it stood on production
 * on 2026-09-27, in sort_order. The bills are the September ones the question
 * exists for: a bed-frame bill keyed the day after an AKEMI fair
 * (HC-SO-2609-127, UNMATCHED), a bed-frame bill the picker linked to the AKEMI
 * booth (HC-SO-2609-219), and a pillow bill with no branding at all
 * (HC-SO-2609-062).
 * ------------------------------------------------------------------------- */

const HOUZS = [
  'BEDFRAME', 'SERVICE', 'ZANOTTI', 'DUNLOPILLO', 'AKEMI', 'ERGOTEX', 'MY SOFA FACTORY',
  'AKEMI Cash & Carry', 'AKEMI FRAGRANCE', 'OTHERS', 'MYLATEX', 'NONE', 'Carres',
];

describe('vpBrandOptions', () => {
  it('keeps the brands in list order and drops the kinds of goods', () => {
    expect(vpBrandOptions(HOUZS)).toEqual([
      'ZANOTTI', 'DUNLOPILLO', 'AKEMI', 'ERGOTEX', 'MY SOFA FACTORY',
      'AKEMI Cash & Carry', 'AKEMI FRAGRANCE', 'MYLATEX', 'Carres',
    ]);
  });

  it('drops blanks and repeats, whatever their case', () => {
    expect(vpBrandOptions([' Akemi ', 'AKEMI', '', 'bedframe', 'Accessories', 'Zanotti'])).toEqual(['Akemi', 'Zanotti']);
  });

  it('treats every kind of goods as not a brand', () => {
    for (const k of NOT_A_BRAND) expect(vpBrandOptions([k, k.toLowerCase()])).toEqual([]);
  });
});

describe('matchVpBrand', () => {
  const options = vpBrandOptions(HOUZS);

  it('answers in the list’s own spelling', () => {
    expect(matchVpBrand(' akemi ', options)).toBe('AKEMI');
    expect(matchVpBrand('carres', options)).toBe('Carres');
  });

  it('names nothing for a kind of goods, a blank or null', () => {
    expect(matchVpBrand('BEDFRAME', options)).toBeNull();
    expect(matchVpBrand('   ', options)).toBeNull();
    expect(matchVpBrand(null, options)).toBeNull();
  });
});

describe('vpBrandAsk', () => {
  const options = vpBrandOptions(HOUZS);

  it('asks for a bed-frame bill, with nothing to suggest when the fair did not link', () => {
    // HC-SO-2609-127: keyed on 21 Sep, the AKEMI fair closed on the 20th -- UNMATCHED.
    expect(vpBrandAsk({ branding: 'BEDFRAME', current: null, boothBrand: null, options }))
      .toEqual({ suggested: null, options });
  });

  it('suggests the linked booth’s brand', () => {
    // HC-SO-2609-219: the picker linked project 347, the AKEMI booth at AICC.
    expect(vpBrandAsk({ branding: 'BEDFRAME', current: null, boothBrand: 'AKEMI', options }))
      .toEqual({ suggested: 'AKEMI', options });
  });

  it('asks for a bill with no branding at all', () => {
    // HC-SO-2609-062: one pillow, branding NULL.
    expect(vpBrandAsk({ branding: null, current: null, boothBrand: null, options })?.options).toEqual(options);
  });

  it('never asks when the products name a brand, or once somebody answered', () => {
    expect(vpBrandAsk({ branding: 'AKEMI', current: null, boothBrand: 'AKEMI', options })).toBeNull();
    expect(vpBrandAsk({ branding: 'zanotti', current: null, boothBrand: null, options })).toBeNull();
    expect(vpBrandAsk({ branding: 'BEDFRAME', current: 'AKEMI', boothBrand: null, options })).toBeNull();
  });

  it('offers no suggestion that is not a choice, and asks nothing with no choices', () => {
    expect(vpBrandAsk({ branding: 'BEDFRAME', current: null, boothBrand: 'BEDFRAME', options })?.suggested).toBeNull();
    expect(vpBrandAsk({ branding: 'BEDFRAME', current: null, boothBrand: 'AKEMI', options: [] })).toBeNull();
  });
});
