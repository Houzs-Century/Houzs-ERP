/* so-branding-label — the Branding column's label rule.

   THE ONE THING THIS SUITE EXISTS FOR: brandingLabel() can never return a
   blank string. Everything else here is the per-company spec around it.

   The bug it closes was not "accessories render blank". It was that a rule
   which had to be total was written as a chain of === comparisons with a bare
   `return ''` at the end, so every category nobody had thought of — including
   the FOUR added to the product enum after it was written — fell out of the
   bottom as nothing. A test that lists the cases someone thought of would have
   passed the whole time. So the domain here is DERIVED (CATEGORY_SOURCES) and
   the assertion is a property over all of it. */
import { describe, expect, test } from 'vitest';

import { brandingLabel, brandingCategoryNoun, CATEGORY_SOURCES, NO_ITEMS_LABEL } from './so-branding-label';
import { normCategory } from '../lib/so-readiness';

const CO_2990 = '2990';
const CO_HOUZS = 'HOUZS';

/* Every shape a category can arrive in, crossed with every shape a brand can.
   Built once and reused so a case added here is added to every property. */
const CATEGORIES: Array<string | null | undefined> = [
  ...CATEGORY_SOURCES.productEnum,
  ...CATEGORY_SOURCES.normBuckets,
  /* mfg_sales_order_items.item_group is free TEXT, so these really do arrive. */
  'BEDFRAME - DIVAN', 'sofa set', ' Mattress  ', 'ACCESSORIES', 'DELIVERY SERVICE',
  'PILLOW', 'BEDFRAME + MATTRESS SET', 'bedlines', 'Carpet', 'BATH_MAT',
  /* absences */
  null, undefined, '', '   ',
];
const BRANDS: Array<string | null | undefined> = [
  null, undefined, '', '   ', '2990', "2990's", '2990s', '2990 PLUS', 'HAPPISLEEP', 'AKEMI', 'CARRES',
];
/* Unrecognised / absent company must behave, not throw or blank out. */
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
    /* A property that silently checked nothing is the failure mode this repo
       has been bitten by twice today, so the size of the domain is asserted
       too — an empty loop cannot pass as a clean run. */
    expect(checked).toBe(CATEGORIES.length * BRANDS.length * COMPANIES.length);
    expect(checked).toBeGreaterThan(2000);
    expect(blanks, `${blanks.length} blank labels out of ${checked}:\n  ${blanks.join('\n  ')}`).toEqual([]);
  });

  test('PROPERTY: a Houzs order is never labelled with a 2990 house brand', () => {
    /* "2990 Mattress" on a Houzs order is not a missing label, it is a false
       one — which is worse than the blank it replaced. The single exception is
       a line whose OWN brand text literally says 2990. */
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

describe('brandingLabel — the 2990 spec (owner 2026-08-17)', () => {
  test('SOFA is 2990\'s own, whatever the line claims', () => {
    expect(brandingLabel('SOFA', null, CO_2990)).toBe('2990 Sofa');
    expect(brandingLabel('SOFA', 'HAPPISLEEP', CO_2990)).toBe('2990 Sofa');
  });

  test('BEDFRAME is the bedframe label', () => {
    expect(brandingLabel('BEDFRAME', 'ANYTHING', CO_2990)).toBe('Bedframe');
  });

  test('MATTRESS follows the item, falling back to the house mattress', () => {
    expect(brandingLabel('MATTRESS', 'HAPPISLEEP', CO_2990)).toBe('HAPPISLEEP');
    expect(brandingLabel('MATTRESS', null, CO_2990)).toBe('2990 Mattress');
    expect(brandingLabel('MATTRESS', '   ', CO_2990)).toBe('2990 Mattress');
    for (const stored of ['2990', "2990's", '2990s', '  2990  ', "2990'S"]) {
      expect(brandingLabel('MATTRESS', stored, CO_2990), `stored ${JSON.stringify(stored)}`).toBe('2990 Mattress');
    }
    /* merely CONTAINING 2990 is a different brand */
    expect(brandingLabel('MATTRESS', '2990 PLUS', CO_2990)).toBe('2990 PLUS');
  });

  test('ACCESSORY and SERVICE say what they are — the owner\'s actual complaint', () => {
    expect(brandingLabel('ACCESSORY', null, CO_2990)).toBe('Accessory');
    expect(brandingLabel('SERVICE', null, CO_2990)).toBe('Service');
  });
});

describe('brandingLabel — the HOUZS spec (owner 2026-08-17)', () => {
  test('SOFA and MATTRESS follow the item\'s own branding', () => {
    expect(brandingLabel('SOFA', 'AKEMI', CO_HOUZS)).toBe('AKEMI');
    expect(brandingLabel('MATTRESS', 'HAPPISLEEP', CO_HOUZS)).toBe('HAPPISLEEP');
  });

  test('and when the item carries no brand, they name the category — never "2990 ..."', () => {
    expect(brandingLabel('SOFA', null, CO_HOUZS)).toBe('Sofa');
    expect(brandingLabel('MATTRESS', null, CO_HOUZS)).toBe('Mattress');
  });

  test('BEDFRAME, SERVICE and ACCESSORY read the same as 2990', () => {
    expect(brandingLabel('BEDFRAME', null, CO_HOUZS)).toBe('Bedframe');
    expect(brandingLabel('SERVICE', null, CO_HOUZS)).toBe('Service');
    expect(brandingLabel('ACCESSORY', null, CO_HOUZS)).toBe('Accessory');
  });

  test('the four Houzs-driven enum members name themselves', () => {
    /* DINING / BEDLINES / DIFFUSER / CARPET were added to mfg_product_category
       by migrations 0258-0265 FOR Houzs SKUs, and normCategory folds all four
       into OTHERS — which is exactly the bucket that used to render blank. */
    expect(brandingLabel('DINING', null, CO_HOUZS)).toBe('Dining');
    expect(brandingLabel('BEDLINES', null, CO_HOUZS)).toBe('Bedlines');
    expect(brandingLabel('DIFFUSER', null, CO_HOUZS)).toBe('Diffuser');
    expect(brandingLabel('CARPET', null, CO_HOUZS)).toBe('Carpet');
  });
});

describe('brandingLabel — defaults and absences', () => {
  test('an unstated company keeps the 2990 reading, so no existing caller changed meaning', () => {
    for (const co of [undefined, null, '', '   ']) {
      expect(brandingLabel('SOFA', null, co), `co=${JSON.stringify(co)}`).toBe('2990 Sofa');
      expect(brandingLabel('MATTRESS', null, co), `co=${JSON.stringify(co)}`).toBe('2990 Mattress');
    }
  });

  test('an order with no readable line says so instead of saying nothing', () => {
    expect(brandingLabel(null, 'HAPPISLEEP', CO_2990)).toBe(NO_ITEMS_LABEL);
    expect(brandingLabel('', null, CO_HOUZS)).toBe(NO_ITEMS_LABEL);
    /* and it is not mistakable for a brand */
    expect(NO_ITEMS_LABEL).not.toMatch(/2990/);
  });
});

describe('brandingCategoryNoun — the superset, refereed against normCategory', () => {
  test('agrees with normCategory on all six of its buckets', () => {
    /* brandingCategoryNoun deliberately handles MORE than normCategory (the raw
       enum members it folds into OTHERS). This asserts the overlap still means
       the same thing, so the superset cannot drift from the rule it extends. */
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
    /* The point of the fallback: the NEXT enum member added does not silently
       become a blank cell the way DINING and CARPET did. */
    expect(brandingCategoryNoun('BATH_MAT').noun).toBe('Bath Mat');
    expect(brandingLabel('BATH_MAT', null, CO_2990)).toBe('Bath Mat');
  });

  test('the derived category list still matches the source it was read from', () => {
    /* If someone adds a member to mfg_product_category and not here, THIS is
       the assertion that should be updated in the same commit — and the
       property test above then covers the new value automatically. */
    expect([...CATEGORY_SOURCES.productEnum]).toEqual([
      'SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE',
      'DINING', 'BEDLINES', 'DIFFUSER', 'CARPET',
    ]);
    expect([...CATEGORY_SOURCES.normBuckets]).toEqual([
      'SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE', 'OTHERS',
    ]);
  });
});
