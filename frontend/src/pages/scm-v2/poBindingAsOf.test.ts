/* A from-scratch PO prices a flat supplier cost at the price in force on the PO
   date (2990-0013): newest history row on or before it, else the current binding. */

import { describe, expect, test } from 'vitest';
import { bindingAsOf, type PriceHistoryRow } from './poBindingAsOf';

const b = { id: 'b1', item_code: 'MAT-1', unit_price_sen: 30_000, price_matrix: null };
const h = (over: Partial<PriceHistoryRow>): PriceHistoryRow => ({
  item_code: 'MAT-1', effective_from: '2026-01-01', created_at: '2026-01-01T00:00:00Z',
  unit_price_sen: 10_000, price_matrix: null, ...over,
});

describe('bindingAsOf', () => {
  test('two prices, PO date between them: the older one is used', () => {
    const rows = [h({}), h({ effective_from: '2026-11-01', unit_price_sen: 20_000 })];
    expect(bindingAsOf(b, rows, '2026-10-24').unit_price_sen).toBe(10_000);
  });

  test('PO date after both: the newest wins', () => {
    const rows = [h({}), h({ effective_from: '2026-11-01', unit_price_sen: 20_000 })];
    expect(bindingAsOf(b, rows, '2026-11-01').unit_price_sen).toBe(20_000);
  });

  test('no row on or before the PO date: the current binding price stays', () => {
    expect(bindingAsOf(b, [h({ effective_from: '2026-11-01' })], '2026-10-24')).toBe(b);
    expect(bindingAsOf(b, [], '2026-10-24')).toBe(b);
  });

  test('same effective date: the later-created row wins; other items are ignored', () => {
    const rows = [h({ unit_price_sen: 1 }), h({ created_at: '2026-02-01T00:00:00Z', unit_price_sen: 2 }), h({ item_code: 'X', unit_price_sen: 3 })];
    expect(bindingAsOf(b, rows, '2026-10-24').unit_price_sen).toBe(2);
  });
});
