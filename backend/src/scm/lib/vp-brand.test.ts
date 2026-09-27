import { describe, it, expect } from 'vitest';
import { NOT_A_BRAND, namesABrand, parseVpBrands, vpBrandOptions, matchVpBrand, vpBrandAsk } from './vp-brand';

/* ---------------------------------------------------------------------------
 * The brand list is Houzs Century's project_brands as it stood on production
 * on 2026-09-27, in sort_order; `vp.brands` is what the migration seeds -- the
 * four brands the Venture Portal has a margin ladder for. The bills are the
 * September ones the question exists for, with their lines as production holds
 * them: a bed-frame bill keyed the day after an AKEMI fair (HC-SO-2609-127,
 * UNMATCHED, line branding BEDFRAME), a bed-frame bill the picker linked to the
 * AKEMI booth (HC-SO-2609-219), and a pillow bill with no branding anywhere
 * (HC-SO-2609-062).
 * ------------------------------------------------------------------------- */

const HOUZS = [
  'BEDFRAME', 'SERVICE', 'ZANOTTI', 'DUNLOPILLO', 'AKEMI', 'ERGOTEX', 'MY SOFA FACTORY',
  'AKEMI Cash & Carry', 'AKEMI FRAGRANCE', 'OTHERS', 'MYLATEX', 'NONE', 'Carres',
];
const PORTAL = parseVpBrands('AKEMI,DUNLOPILLO,ERGOTEX,ZANOTTI');

describe('namesABrand', () => {
  it('is a brand unless blank, a placeholder or a kind of goods', () => {
    expect(namesABrand('AKEMI')).toBe(true);
    expect(namesABrand('MYLATEX')).toBe(true);
    for (const v of [null, '', '  ', 'NONE', 'n/a', 'TBC', 'BEDFRAME', 'Service', 'accessory']) {
      expect(namesABrand(v)).toBe(false);
    }
    for (const k of NOT_A_BRAND) expect(namesABrand(k.toLowerCase())).toBe(false);
  });
});

describe('parseVpBrands', () => {
  it('reads the setting as a list, spaces, blanks and repeats ignored', () => {
    expect(parseVpBrands(' AKEMI , dunlopillo,,AKEMI ')).toEqual(['AKEMI', 'dunlopillo']);
    expect(parseVpBrands(null)).toEqual([]);
  });
});

describe('vpBrandOptions', () => {
  it('offers the brands the portal pays on, in this company’s order and spelling', () => {
    expect(vpBrandOptions(HOUZS, PORTAL)).toEqual(['ZANOTTI', 'DUNLOPILLO', 'AKEMI', 'ERGOTEX']);
  });

  it('never offers a kind of goods, a brand the company lacks, or one twice', () => {
    expect(vpBrandOptions(['Akemi', 'AKEMI', 'BEDFRAME', ' zanotti '], ['AKEMI', 'ZANOTTI', 'BEDFRAME', 'ERGOTEX']))
      .toEqual(['Akemi', 'zanotti']);
    expect(vpBrandOptions(HOUZS, [])).toEqual([]);
  });
});

describe('matchVpBrand', () => {
  const options = vpBrandOptions(HOUZS, PORTAL);

  it('answers in the list’s own spelling', () => {
    expect(matchVpBrand(' akemi ', options)).toBe('AKEMI');
  });

  it('names nothing outside the choices, for a blank or for null', () => {
    expect(matchVpBrand('MYLATEX', options)).toBeNull();
    expect(matchVpBrand('BEDFRAME', options)).toBeNull();
    expect(matchVpBrand('   ', options)).toBeNull();
    expect(matchVpBrand(null, options)).toBeNull();
  });
});

describe('vpBrandAsk', () => {
  const options = vpBrandOptions(HOUZS, PORTAL);
  const ask = (o: Partial<Parameters<typeof vpBrandAsk>[0]>) =>
    vpBrandAsk({ branding: 'BEDFRAME', lineBrandings: ['BEDFRAME'], current: null, boothBrand: null, options, ...o });

  it('asks for a bed-frame bill, with nothing to suggest when the fair did not link', () => {
    // HC-SO-2609-127: keyed on 21 Sep, the AKEMI fair closed on the 20th -- UNMATCHED.
    expect(ask({})).toEqual({ suggested: null, options });
  });

  it('suggests the linked booth’s brand', () => {
    // HC-SO-2609-219: the picker linked project 347, the AKEMI booth at AICC.
    expect(ask({ boothBrand: 'AKEMI' })).toEqual({ suggested: 'AKEMI', options });
  });

  it('asks for a bill with no branding anywhere', () => {
    // HC-SO-2609-062: one pillow, branding NULL on the header and the line.
    expect(ask({ branding: null, lineBrandings: [null] })?.options).toEqual(options);
  });

  it('never asks when ANY line names a brand -- even one the portal does not pay on', () => {
    // A Dunlopillo pillow beside a bed frame: the products name a brand.
    expect(ask({ lineBrandings: ['BEDFRAME', 'DUNLOPILLO'] })).toBeNull();
    expect(ask({ branding: null, lineBrandings: [null, 'MYLATEX'] })).toBeNull();
  });

  it('never asks when the header names a brand, or once somebody answered', () => {
    expect(ask({ branding: 'AKEMI', lineBrandings: ['AKEMI'] })).toBeNull();
    expect(ask({ current: 'AKEMI' })).toBeNull();
  });

  it('offers no suggestion that is not a choice, and asks nothing with no choices', () => {
    expect(ask({ boothBrand: 'AKEMI FRAGRANCE' })?.suggested).toBeNull();
    expect(ask({ options: [] })).toBeNull();
  });
});
