import { describe, expect, test } from 'vitest';
import { MFG_PRODUCT_CATEGORIES, isSingleSkuCategory } from './product-categories';

describe('isSingleSkuCategory — which Models carry exactly one SKU (BUG-85)', () => {
  test('Sofa / Bedframe / Mattress have a size or compartment axis', () => {
    expect(isSingleSkuCategory('SOFA')).toBe(false);
    expect(isSingleSkuCategory('BEDFRAME')).toBe(false);
    expect(isSingleSkuCategory('MATTRESS')).toBe(false);
  });

  test('every other category is single-SKU, Sofa Accessory included', () => {
    const sized = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);
    for (const c of MFG_PRODUCT_CATEGORIES) {
      expect(isSingleSkuCategory(c)).toBe(!sized.has(c));
    }
    expect(isSingleSkuCategory('FABRIC_ACCESSORY')).toBe(true);
  });

  test('reads lower case; a blank or unknown value is not a category', () => {
    expect(isSingleSkuCategory('fabric_accessory')).toBe(true);
    expect(isSingleSkuCategory('')).toBe(false);
    expect(isSingleSkuCategory(null)).toBe(false);
    expect(isSingleSkuCategory('CHAIR')).toBe(false);
  });
});
