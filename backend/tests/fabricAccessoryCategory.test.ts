import { describe, expect, test } from 'vitest';
import { computeVariantKey } from '../src/scm/shared/variant-key';
import { missingVariantAxes } from '../src/scm/shared/so-variant-rule';
import { isHardBoundLine } from '../src/scm/lib/so-stock-allocation';
import { attributesTheGroupWillIgnore } from '../src/scm/lib/sku-category';
import { NO_BUFFERS, NO_OVERRIDES, resolveLeadDays } from '../src/scm/lib/lead-time';

/* THE SOFA ACCESSORY CATEGORY (owner 2026-09-14), group `fabric_accessory`.

   MRP handed every custom square pillow the same stock whatever colour the
   customer wanted, because an `accessory` keys on its code alone. The owner's
   design: a category whose lines pick a fabric colour like a sofa, key their
   stock by that colour, and bind per order. tasks/PLAN-sofa-accessories-category.md.

   Each test below pins one half of that, including the two it must NOT do: it
   must not inherit a sofa's seat and leg, and it must not be mistaken for a sofa
   by name (41 readers test a group with includes('sofa')). */

describe('fabric_accessory keys stock by COLOUR and nothing else', () => {
  test('the fabric composes the key', () => {
    expect(computeVariantKey('fabric_accessory', { fabricCode: 'PC151-01' })).toBe('fabriccode=pc151-01');
  });

  test('two colours of the same pillow are two buckets — the defect this category exists for', () => {
    expect(computeVariantKey('fabric_accessory', { fabricCode: 'PC151-01' }))
      .not.toBe(computeVariantKey('fabric_accessory', { fabricCode: 'PC151-02' }));
  });

  test('a seat or leg on the line does not split the bucket — a pillow has neither', () => {
    expect(computeVariantKey('fabric_accessory', { fabricCode: 'PC151-01', seatHeight: '32', legHeight: '6' }))
      .toBe('fabriccode=pc151-01');
  });

  test('the GRN-family spelling of the fabric lands in the same bucket', () => {
    expect(computeVariantKey('fabric_accessory', { fabricColor: 'PC151-01' }))
      .toBe(computeVariantKey('fabric_accessory', { fabricCode: 'PC151-01' }));
  });

  test('a plain accessory is unchanged: code only, colour ignored', () => {
    expect(computeVariantKey('accessory', { fabricCode: 'PC151-01' })).toBe('');
  });
});

describe('fabric_accessory requires a fabric on the order, and only a fabric', () => {
  test('a line with no colour is missing exactly Fabrics', () => {
    expect(missingVariantAxes('fabric_accessory', {}, 'SQUARE PILLOW').map((a) => a.key)).toEqual(['fabricCode']);
  });

  test('a line with a colour is complete — no seat, leg, gap or divan is asked', () => {
    expect(missingVariantAxes('fabric_accessory', { fabricCode: 'PC151-01' }, 'SQUARE PILLOW')).toEqual([]);
  });

  test('a plain accessory still asks for nothing', () => {
    expect(missingVariantAxes('accessory', {}, 'AMN-SOFA PILLOW')).toEqual([]);
  });
});

describe('fabric_accessory binds per order in MRP, like a sofa', () => {
  test('it is a hard-bound line', () => {
    expect(isHardBoundLine('fabric_accessory', 'SQUARE PILLOW')).toBe(true);
    expect(isHardBoundLine('FABRIC_ACCESSORY', 'LONG PILLOW')).toBe(true);
  });

  test('a plain accessory stays pooled', () => {
    expect(isHardBoundLine('accessory', 'AMN-SOFA PILLOW')).toBe(false);
  });
});

describe('fabric_accessory takes the sofa lead days — it is ordered on the sofa PO', () => {
  const base = { byWhCat: new Map<string, number>(), byCat: new Map([['sofa', 7], ['accessory', 0]]) };
  const input = (category: string) => ({
    warehouseId: null, category, supplierId: null, supplierCode: null, deliveryDate: null,
  });

  test('base lead days come from the sofa row', () => {
    expect(resolveLeadDays(base, NO_OVERRIDES, NO_BUFFERS, input('fabric_accessory')).base).toBe(7);
  });

  test('a plain accessory keeps its own row', () => {
    expect(resolveLeadDays(base, NO_OVERRIDES, NO_BUFFERS, input('accessory')).base).toBe(0);
  });
});

describe('the contradiction detector knows the new group composes the fabric', () => {
  test('a fabric on a fabric_accessory line is NOT reported as thrown away', () => {
    expect(attributesTheGroupWillIgnore('fabric_accessory', { fabricCode: 'PC151-01' })).toEqual([]);
  });

  test('a seat on a fabric_accessory line IS reported — the key ignores it', () => {
    expect(attributesTheGroupWillIgnore('fabric_accessory', { fabricCode: 'PC151-01', seatHeight: '32' })).toEqual(['seatHeight']);
  });
});
