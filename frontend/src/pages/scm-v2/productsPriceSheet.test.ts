// The SKU price sheet writes ringgit with two decimals (owner 2026-09-15: every
// amount reads the way AutoCount prints it) — never sen, never a bare "1535".
// docs/bugs/0928-datagrid-export-wrote-money-as-rm-text-or-blank-cells-and-ha.md
import { describe, expect, test } from 'vitest';
import { priceSheetRinggit } from './Products';

describe('priceSheetRinggit', () => {
  test('two decimals, ringgit, blank when unset', () => {
    expect(priceSheetRinggit(153_500)).toBe('1535.00');
    expect(priceSheetRinggit(153_550)).toBe('1535.50');
    expect(priceSheetRinggit(5)).toBe('0.05');
    expect(priceSheetRinggit(null)).toBe('');
    expect(priceSheetRinggit(undefined)).toBe('');
  });
});
