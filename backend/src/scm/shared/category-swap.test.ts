import { describe, expect, test } from 'vitest';
import { categorySwapAllowed } from './category-swap';
import { isSingleSkuCategory, mfgCategoryLabel, parseMfgCategory, activeProductCategories, type ProductCategory } from './product-categories';

/* A registry as scm.acc_item_groups hands it over: one switched off, one added at runtime. */
const LIST: ProductCategory[] = [
  { code: 'SOFA', name: 'Sofa', isActive: true },
  { code: 'ACCESSORY', name: 'Accessory', isActive: true },
  { code: 'FABRIC_ACCESSORY', name: 'Sofa Accessory', isActive: true },
  { code: 'MATTRESS', name: 'Mattress', isActive: true },
  { code: 'BATH_MAT', name: 'Bath Mat', isActive: true },
  { code: 'OLD_GROUP', name: 'Old Group', isActive: false },
];

describe('categorySwapAllowed — any active registry category, other than the current one', () => {
  test('every active category can move to every other active category', () => {
    for (const from of activeProductCategories(LIST)) {
      for (const to of activeProductCategories(LIST)) {
        expect(categorySwapAllowed(LIST, from.code, to.code)).toBe(from.code !== to.code);
      }
    }
  });
  test('a category added in the registry is a target with no code change', () => {
    expect(categorySwapAllowed(LIST, 'SOFA', 'BATH_MAT')).toBe(true);
  });
  test('a no-op, a switched-off or unknown target, or a blank is not a swap', () => {
    expect(categorySwapAllowed(LIST, 'sofa', 'SOFA')).toBe(false);
    expect(categorySwapAllowed(LIST, 'SOFA', 'OLD_GROUP')).toBe(false);
    expect(categorySwapAllowed(LIST, 'SOFA', 'CHAIR')).toBe(false);
    expect(categorySwapAllowed(LIST, 'SOFA', '')).toBe(false);
    expect(categorySwapAllowed(LIST, 'SOFA', null)).toBe(false);
  });
  test('case, and a row with no category yet', () => {
    expect(categorySwapAllowed(LIST, 'accessory', 'fabric_accessory')).toBe(true);
    expect(categorySwapAllowed(LIST, null, 'ACCESSORY')).toBe(true);
  });
});

describe('labels and parsing come from the registry names', () => {
  test('the label is the registry name', () => {
    expect(mfgCategoryLabel(LIST, 'FABRIC_ACCESSORY')).toBe('Sofa Accessory');
    expect(mfgCategoryLabel(LIST, 'accessory')).toBe('Accessory');
    expect(mfgCategoryLabel(LIST, 'BATH_MAT')).toBe('Bath Mat');
  });
  test('a code not in the list reads in Title Case; other text as stored', () => {
    expect(mfgCategoryLabel([], 'NEW_GROUP')).toBe('New Group');
    expect(mfgCategoryLabel(LIST, 'Chair set')).toBe('Chair set');
    expect(mfgCategoryLabel(LIST, null)).toBe('');
  });
  test('a sheet cell reads by code in any case or by name', () => {
    expect(parseMfgCategory(LIST, 'fabric_accessory')).toBe('FABRIC_ACCESSORY');
    expect(parseMfgCategory(LIST, 'Sofa accessory')).toBe('FABRIC_ACCESSORY');
    expect(parseMfgCategory(LIST, 'bath mat')).toBe('BATH_MAT');
    expect(parseMfgCategory(LIST, 'chair')).toBeNull();
    expect(parseMfgCategory(LIST, '  ')).toBeNull();
  });
});

describe('isSingleSkuCategory — which Models carry exactly one SKU (BUG-85)', () => {
  test('Sofa / Bedframe / Mattress have a size or compartment axis', () => {
    for (const c of ['SOFA', 'BEDFRAME', 'mattress']) expect(isSingleSkuCategory(c)).toBe(false);
  });
  test('every other category is single-SKU, a new one included; a blank is not', () => {
    for (const c of ['ACCESSORY', 'fabric_accessory', 'DINING', 'BATH_MAT']) expect(isSingleSkuCategory(c)).toBe(true);
    expect(isSingleSkuCategory('')).toBe(false);
    expect(isSingleSkuCategory(null)).toBe(false);
  });
});
