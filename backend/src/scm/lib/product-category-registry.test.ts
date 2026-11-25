import { describe, expect, test } from 'vitest';
import { toProductCategories, loadProductCategories } from './product-category-registry';

describe('product categories from scm.acc_item_groups', () => {
  test('upper-cases codes, falls back to the code for a blank name, keeps inactive rows, sorts by name', () => {
    expect(toProductCategories([
      { code: 'sofa', name: 'Sofa', is_active: true },
      { code: 'FABRIC_ACCESSORY', name: ' Sofa Accessory ', is_active: null },
      { code: 'OLD', name: '', is_active: false },
      { code: ' ', name: 'blank', is_active: true },
    ])).toEqual([
      { code: 'OLD', name: 'OLD', isActive: false },
      { code: 'SOFA', name: 'Sofa', isActive: true },
      { code: 'FABRIC_ACCESSORY', name: 'Sofa Accessory', isActive: true },
    ]);
  });
  test('a read error throws, so a write is never checked against an empty list', async () => {
    const sb = { from: () => ({ select: async () => ({ data: null, error: { message: 'boom' } }) }) };
    await expect(loadProductCategories(sb as never)).rejects.toThrow('product_categories_load_failed: boom');
  });
});
