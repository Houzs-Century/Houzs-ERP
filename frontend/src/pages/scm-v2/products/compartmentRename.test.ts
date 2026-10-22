import { describe, expect, test } from 'vitest';
import { describeRenameCounts } from './compartmentRename';

describe('describeRenameCounts', () => {
  test('names the rows in use and leaves out zeros', () => {
    expect(describeRenameCounts({ 'mfg_products.code': 14, 'grn_items.item_code': 0, 'inventory_movements.item_code': 12 }))
      .toBe('14 SKUs, 12 stock movements');
  });

  test('an unknown table is shown by its own name, and nothing at all is empty', () => {
    expect(describeRenameCounts({ 'stock_take_lines.item_code': 2 })).toBe('2 stock_take_lines.item_code');
    expect(describeRenameCounts({ product_models: 0 })).toBe('');
  });
});
