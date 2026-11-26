import { describe, expect, test } from 'vitest';

import { brandingLabel, isPlaceholderBrandText, brandingCategoryNoun, CATEGORY_SOURCES, NO_ITEMS_LABEL } from './so-branding-label';
import { normCategory } from '../lib/so-readiness';

const CO_2990 = '2990';
const CO_HOUZS = 'HOUZS';

const CATEGORIES: Array<string | null | undefined> = [
  ...CATEGORY_SOURCES.categoryNouns,
      'FABRIC_ACCESSORY', 'NEW_GROUP',
  ...CATEGORY_SOURCES.normBuckets,
  'BEDFRAME - DIVAN', 'sofa set', ' Mattress  ', 'ACCESSORIES', 'DELIVERY SERVICE',
  'PILLOW', 'BEDFRAME + MATTRESS SET', 'bedlines', 'Carpet', 'BATH_MAT',
  null, undefined, '', '   ',
];
const BRANDS: Array<string | null | undefined> = [
  null, undefined, '', '   ', '2990', "2990's", '2990s', '2990 PLUS', 'HAPPISLEEP', 'AKEMI', 'CARRES',
];
const COMPANIES: Array<string | null | undefined> = [
  undefined, null, '', '  ', CO_2990, CO_HOUZS, 'houzs', ' HOUZS ', 'SOMETHING-ELSE',
];

describe('brandingLabel — THE INVARIANT', () => {
  test('PROPERTY: never returns a blank label, for any category x brand x company', () => {
    const blanks: string[] = [];
    let checked = 0;
    for (const cat of CATEGORIES) {
      for (const brand of BRANDS) {
        for (const co of COMPANIES) {
          checked += 1;
          const label = brandingLabel(cat, brand, co);
          if (typeof label !== 'string' || label.trim() === '') {
            blanks.push(`cat=${JSON.stringify(cat)} brand=${JSON.stringify(brand)} co=${JSON.stringify(co)} -> ${JSON.stringify(label)}`);
          }
        }
      }
    }
    expect(checked).toBe(CATEGORIES.length * BRANDS.length * COMPANIES.length);
    expect(checked).toBeGreaterThan(2000);
    expect(blanks, `${blanks.length} blank labels out of ${checked}:\n  ${blanks.join('\n  ')}`).toEqual([]);
  });

  test('PROPERTY: a Houzs order is never labelled with a 2990 house brand', () => {
    const lies: string[] = [];
    for (const cat of CATEGORIES) {
      for (const brand of BRANDS) {
        const brandSaysHouse = /2990/.test(String(brand ?? ''));
        const label = brandingLabel(cat, brand, CO_HOUZS);
        if (/2990/.test(label) && !brandSaysHouse) {
          lies.push(`cat=${JSON.stringify(cat)} brand=${JSON.stringify(brand)} -> ${JSON.stringify(label)}`);
        }
      }
    }
    expect(lies, `${lies.length} Houzs rows labelled 2990:\n  ${lies.join('\n  ')}`).toEqual([]);
  });
});

describe('brandingLabel — the 2990 spec (owner 2026-08-18)', () => {
  test('SOFA is 2990\'s own, whatever the line claims', () => {
    expect(brandingLabel('SOFA', null, CO_2990)).toBe('2990s Sofa');
    expect(brandingLabel('SOFA', 'HAPPISLEEP', CO_2990)).toBe('2990s Sofa');
  });

  test('the sofa label is spelled the way the brand master spells it', () => {
    expect(brandingLabel('SOFA', null, CO_2990)).toBe('2990s Sofa');
    expect(brandingLabel('SOFA', null, CO_2990)).not.toBe('2990 Sofa');
  });

  test('BEDFRAME is the bedframe label', () => {
    expect(brandingLabel('BEDFRAME', 'ANYTHING', CO_2990)).toBe('Bedframe');
  });

  test('MATTRESS follows the SKU, and names the category when the SKU has none', () => {
    expect(brandingLabel('MATTRESS', 'Happi.S Mattress', CO_2990)).toBe('Happi.S Mattress');
    expect(brandingLabel('MATTRESS', '2990s Mattress', CO_2990)).toBe('2990s Mattress');
    expect(brandingLabel('MATTRESS', 'Carres Mattress', CO_2990)).toBe('Carres Mattress');
    expect(brandingLabel('MATTRESS', null, CO_2990)).toBe('Mattress');
    expect(brandingLabel('MATTRESS', '   ', CO_2990)).toBe('Mattress');
  });

  test('NO house-mattress label is synthesised any more', () => {
    expect(brandingLabel('MATTRESS', null, CO_2990)).not.toBe('2990 Mattress');
    for (const stored of ['2990', "2990's", '2990s', '  2990  ']) {
      const label = brandingLabel('MATTRESS', stored, CO_2990);
      expect(label, `stored ${JSON.stringify(stored)}`).toBe(stored.trim());
    }
  });

  test('ACCESSORY and SERVICE say what they are — the owner\'s actual complaint', () => {
    expect(brandingLabel('ACCESSORY', null, CO_2990)).toBe('Accessory');
    expect(brandingLabel('SERVICE', null, CO_2990)).toBe('Service');
    /* «如果那个 SKU 有 branding 就根据 branding» — an accessory SKU branded
       Accessories reads Accessories even when the line text says Happi.S. The
       label rule only ever sees the resolved value; the caller does the
       resolving, and the backfill aligns the stored lines with it. */
    expect(brandingLabel('ACCESSORY', 'Accessories', CO_2990)).toBe('Accessory');
  });
});

describe('brandingLabel — the HOUZS spec (owner 2026-08-18)', () => {
  test('SOFA is ZANOTTI, whatever the line claims', () => {
    expect(brandingLabel('SOFA', 'AKEMI', CO_HOUZS)).toBe('ZANOTTI');
    expect(brandingLabel('SOFA', null, CO_HOUZS)).toBe('ZANOTTI');
    expect(brandingLabel('SOFA', '   ', CO_HOUZS)).toBe('ZANOTTI');
  });

  test('an unbranded sofa SKU no longer degrades to the bare category noun', () => {
    expect(brandingLabel('SOFA', null, CO_HOUZS)).not.toBe('Sofa');
  });

  test('MATTRESS follows the SKU, exactly as 2990 does', () => {
    expect(brandingLabel('MATTRESS', 'AKEMI', CO_HOUZS)).toBe('AKEMI');
    expect(brandingLabel('MATTRESS', 'DUNLOPILLO', CO_HOUZS)).toBe('DUNLOPILLO');
    for (const brand of ['AKEMI', 'DUNLOPILLO', 'ERGOTEX', 'MYLATEX', null, '  ']) {
      expect(brandingLabel('MATTRESS', brand, CO_HOUZS), `brand=${JSON.stringify(brand)}`)
        .toBe(brandingLabel('MATTRESS', brand, CO_2990));
    }
  });

  test('and when the SKU carries no brand, the mattress names the category', () => {
    expect(brandingLabel('MATTRESS', null, CO_HOUZS)).toBe('Mattress');
  });

  test('BEDFRAME, SERVICE and ACCESSORY read the same as 2990', () => {
    expect(brandingLabel('BEDFRAME', null, CO_HOUZS)).toBe('Bedframe');
    expect(brandingLabel('SERVICE', null, CO_HOUZS)).toBe('Service');
    expect(brandingLabel('ACCESSORY', null, CO_HOUZS)).toBe('Accessory');
  });

  test('the four Houzs-driven enum members name themselves', () => {
    expect(brandingLabel('DINING', null, CO_HOUZS)).toBe('Dining');
    expect(brandingLabel('BEDLINES', null, CO_HOUZS)).toBe('Bedlines');
    expect(brandingLabel('DIFFUSER', null, CO_HOUZS)).toBe('Diffuser');
    expect(brandingLabel('CARPET', null, CO_HOUZS)).toBe('Carpet');
  });
});

describe('brandingLabel — defaults and absences', () => {
  test('an unstated company keeps the 2990 reading, so no existing caller changed meaning', () => {
    for (const co of [undefined, null, '', '   ']) {
      expect(brandingLabel('SOFA', null, co), `co=${JSON.stringify(co)}`).toBe('2990s Sofa');
      expect(brandingLabel('MATTRESS', null, co), `co=${JSON.stringify(co)}`).toBe('Mattress');
    }
  });

  test('an order with no readable line says so instead of saying nothing', () => {
    expect(brandingLabel(null, 'HAPPISLEEP', CO_2990)).toBe(NO_ITEMS_LABEL);
    expect(brandingLabel('', null, CO_HOUZS)).toBe(NO_ITEMS_LABEL);
    expect(NO_ITEMS_LABEL).not.toMatch(/2990/);
  });
});

describe('brandingCategoryNoun — the superset, refereed against normCategory', () => {
  test('agrees with normCategory on all six of its buckets', () => {
    const NOUN_FOR_BUCKET: Record<string, string> = {
      SOFA: 'Sofa', BEDFRAME: 'Bedframe', MATTRESS: 'Mattress',
      ACCESSORY: 'Accessory', SERVICE: 'Service', OTHERS: 'Other',
    };
    const probes = ['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE', 'OTHERS',
                    'BEDFRAME - DIVAN', 'sofa set', ' Mattress  ', 'ACCESSORIES',
                    'DELIVERY SERVICE', 'BEDFRAME + MATTRESS SET'];
    let compared = 0;
    for (const p of probes) {
      const bucket = normCategory(p);
      compared += 1;
      expect(brandingCategoryNoun(p).noun, `${p} bucketed ${bucket}`).toBe(NOUN_FOR_BUCKET[bucket]);
    }
    expect(compared).toBe(probes.length);
  });

  test('BEDFRAME wins over MATTRESS — the branch ORDER is the rule', () => {
    expect(brandingCategoryNoun('BEDFRAME + MATTRESS SET').noun).toBe('Bedframe');
    expect(brandingLabel('BEDFRAME + MATTRESS SET', 'HAPPISLEEP', CO_2990)).toBe('Bedframe');
  });

  test('a category nobody has written a noun for still names itself', () => {
    expect(brandingCategoryNoun('BATH_MAT').noun).toBe('Bath Mat');
    expect(brandingLabel('BATH_MAT', null, CO_2990)).toBe('Bath Mat');
  });

  test('the derived category list still matches the source it was read from', () => {
    expect(CATEGORY_SOURCES.categoryNouns).toEqual([
      'BEDFRAME', 'SOFA', 'MATTRESS', 'ACCESSORY', 'SERVICE', 'BEDLINES', 'DIFFUSER', 'DINING', 'CARPET',
    ]);
    expect([...CATEGORY_SOURCES.normBuckets]).toEqual([
      'SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE', 'OTHERS',
    ]);
  });
});

/* 2026-08-31 (owner: 「我这个 BedFrame,它的 branding 不是 BedFrame 呢?」).
   HC-SO-013402 is a TRION bedframe whose HEADER branding is the literal text
   "NONE" — copied faithfully from the book, where 170 imported orders carry it.
   Every reader treats a non-blank header as authoritative, so the derived
   label ("BEDFRAME", or the product's own brand) never got a chance and the
   screen printed NONE. The text is not a brand; it is the book's way of
   writing "no brand". */
describe('isPlaceholderBrandText — the book\'s ways of writing "no brand"', () => {
  test('the placeholder spellings are all blank-equivalent', () => {
    for (const s of ['NONE', 'none', ' None ', 'N/A', 'n.a.', 'NIL', '-', '--', 'TBC', ''])
      expect(isPlaceholderBrandText(s)).toBe(true);
    expect(isPlaceholderBrandText(null)).toBe(true);
    expect(isPlaceholderBrandText(undefined)).toBe(true);
  });
  test('a real brand is never treated as blank', () => {
    for (const s of ['AKEMI', 'ZANOTTI', 'DUNLOPILLO', 'ERGOTEX', 'MYLATEX', 'BEDFRAME', 'Nonesuch'])
      expect(isPlaceholderBrandText(s)).toBe(false);
  });
});
