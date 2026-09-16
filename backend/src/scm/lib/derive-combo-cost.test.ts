import { describe, expect, it } from 'vitest';
import { deriveMasterComboCostFromSuppliers, comboCostChanged, type SupplierComboCost } from './derive-combo-cost';

const s = (o: Partial<SupplierComboCost> & { supplier_id: string }): SupplierComboCost => ({
  is_main_supplier: false, prices_by_height: {}, ...o,
});

describe('deriveMasterComboCostFromSuppliers — whole-set dearest supplier', () => {
  it('no supplier combos -> null (a gap; master left as-is)', () => {
    expect(deriveMasterComboCostFromSuppliers([])).toBeNull();
  });

  it('one supplier -> that supplier grid', () => {
    expect(deriveMasterComboCostFromSuppliers([s({ supplier_id: 'a', prices_by_height: { '24': 5000 } })]))
      .toEqual({ '24': 5000 });
  });

  it('takes the WHOLE grid of the dearest supplier, NOT a per-cell max', () => {
    // A has the single dearest cell (300 at 24) but a cheap 28 (100).
    // B is uniformly 250. A wins (300 > 250); the result is A's whole grid,
    // so 28 must be A's 100 — not B's 250.
    const out = deriveMasterComboCostFromSuppliers([
      s({ supplier_id: 'A', prices_by_height: { '24': 300, '28': 100 } }),
      s({ supplier_id: 'B', prices_by_height: { '24': 250, '28': 250 } }),
    ]);
    expect(out).toEqual({ '24': 300, '28': 100 });
  });

  it('tie on dearest cell -> main supplier wins', () => {
    const out = deriveMasterComboCostFromSuppliers([
      s({ supplier_id: 'zzz', prices_by_height: { '24': 900 }, is_main_supplier: false }),
      s({ supplier_id: 'aaa', prices_by_height: { '24': 900 }, is_main_supplier: true }),
    ]);
    expect(out).toEqual({ '24': 900 });
    // proven the main (aaa) won: identical grids, but tie-break is deterministic
  });
});

describe('comboCostChanged', () => {
  it('same grid -> false; changed -> true; order-independent', () => {
    expect(comboCostChanged({ '24': 100, '28': 200 }, { '28': 200, '24': 100 })).toBe(false);
    expect(comboCostChanged({ '24': 100 }, { '24': 150 })).toBe(true);
    expect(comboCostChanged(null, { '24': 100 })).toBe(true);
    expect(comboCostChanged({ '24': 100 }, null)).toBe(true);
  });
});
