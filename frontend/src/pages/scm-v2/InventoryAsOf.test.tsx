// The as-of view's category subtotals (GL redesign item 5): they must always
// sum back to the grand total — a subtotal chip that disagrees with the cards
// would be the screen arguing with itself.

import { describe, expect, test } from 'vitest';
import { categorySubtotals } from './Inventory';

const row = (item_code: string, category: string | null, qty: number, value_sen: number) =>
  ({ item_code, product_name: item_code, category, qty, value_sen });

describe('categorySubtotals', () => {
  test('groups, sums, sorts by value, and never loses a ringgit to the grouping', () => {
    const rows = [
      row('S1', 'SOFA', 2, 300_000),
      row('S2', 'SOFA', 1, 150_000),
      row('M1', 'MATTRESS', 5, 500_000),
      row('X1', null, 1, 5_000),
    ];
    const subs = categorySubtotals(rows);
    expect(subs.map((s) => s.category)).toEqual(['MATTRESS', 'SOFA', '(no category)']);
    expect(subs.find((s) => s.category === 'SOFA')).toEqual({ category: 'SOFA', qty: 3, valueSen: 450_000 });
    expect(subs.reduce((s, x) => s + x.valueSen, 0)).toBe(rows.reduce((s, r) => s + r.value_sen, 0));
    expect(subs.reduce((s, x) => s + x.qty, 0)).toBe(rows.reduce((s, r) => s + r.qty, 0));
  });

  test('an empty day is an empty list, not a crash', () => {
    expect(categorySubtotals([])).toEqual([]);
  });
});
