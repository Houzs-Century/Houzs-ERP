import { describe, expect, test } from 'vitest';
import { categorySwapAllowed } from './category-swap';
import { MFG_PRODUCT_CATEGORIES, MFG_CATEGORY_LABELS, mfgCategoryLabel } from './product-categories';

describe('categorySwapAllowed — any valid category, other than the current one', () => {
  test('every category can move to every other category', () => {
    for (const from of MFG_PRODUCT_CATEGORIES) {
      for (const to of MFG_PRODUCT_CATEGORIES) {
        expect(categorySwapAllowed(from, to)).toBe(from !== to);
      }
    }
  });
  test('a no-op is not a swap', () => {
    expect(categorySwapAllowed('ACCESSORY', 'ACCESSORY')).toBe(false);
    expect(categorySwapAllowed('sofa', 'SOFA')).toBe(false);
  });
  test('the target must be a real category', () => {
    expect(categorySwapAllowed('SOFA', 'CHAIR')).toBe(false);
    expect(categorySwapAllowed('SOFA', '')).toBe(false);
    expect(categorySwapAllowed('SOFA', null)).toBe(false);
  });
  test('case, and a row with no category yet', () => {
    expect(categorySwapAllowed('accessory', 'fabric_accessory')).toBe(true);
    expect(categorySwapAllowed(null, 'ACCESSORY')).toBe(true);
  });
});

describe('one label per category', () => {
  test('every category has a label and Sofa Accessory is the only renamed one', () => {
    for (const c of MFG_PRODUCT_CATEGORIES) expect(MFG_CATEGORY_LABELS[c]).toBeTruthy();
    expect(mfgCategoryLabel('FABRIC_ACCESSORY')).toBe('Sofa Accessory');
    expect(mfgCategoryLabel('ACCESSORY')).toBe('Accessory');
    expect(mfgCategoryLabel('accessory')).toBe('Accessory');
  });
  test('an unknown value is shown as stored', () => {
    expect(mfgCategoryLabel('CHAIR')).toBe('CHAIR');
    expect(mfgCategoryLabel(null)).toBe('');
  });
});
