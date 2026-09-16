import { describe, expect, it } from 'vitest';
import {
  deriveProductCostFromSuppliers,
  type DeriveResult,
  type SupplierBindingCost,
} from './derive-product-cost-from-suppliers';

function chosen(r: DeriveResult) {
  if (r.skipped) throw new Error(`expected a patch, got skipped: ${r.reason}`);
  return r;
}

const b = (o: Partial<SupplierBindingCost> & { supplier_id: string }): SupplierBindingCost => ({
  is_main_supplier: false,
  unit_price_sen: null,
  price_matrix: null,
  ...o,
});

describe('deriveProductCostFromSuppliers — the gap case', () => {
  it('no bindings -> skipped (a binding gap, never a fabricated 0)', () => {
    const r = deriveProductCostFromSuppliers('MATTRESS', []);
    expect(r.skipped).toBe(true);
    if (r.skipped) expect(r.reason).toBe('no_supplier_binding');
  });
});

describe('deriveProductCostFromSuppliers — FLAT (mattress/accessory/service)', () => {
  it('one supplier -> its flat price becomes base_price_sen', () => {
    const r = chosen(deriveProductCostFromSuppliers('MATTRESS', [b({ supplier_id: 's1', unit_price_sen: 120000 })]));
    expect(r.chosenSupplierId).toBe('s1');
    expect(r.patch.base_price_sen).toBe(120000);
    expect(r.patch.seat_height_prices).toBeUndefined();
  });

  it('many suppliers -> the MOST EXPENSIVE flat price wins', () => {
    const r = chosen(
      deriveProductCostFromSuppliers('ACCESSORY', [
        b({ supplier_id: 'cheap', unit_price_sen: 5000 }),
        b({ supplier_id: 'dear', unit_price_sen: 9000 }),
        b({ supplier_id: 'mid', unit_price_sen: 7000 }),
      ]),
    );
    expect(r.chosenSupplierId).toBe('dear');
    expect(r.patch.base_price_sen).toBe(9000);
    expect(r.dearnessSen).toBe(9000);
  });
});

describe('deriveProductCostFromSuppliers — BEDFRAME (matrix {P1,P2})', () => {
  it('maps the dearest supplier matrix P2->base_price_sen, P1->price1_sen', () => {
    const r = chosen(
      deriveProductCostFromSuppliers('BEDFRAME', [
        b({ supplier_id: 'a', price_matrix: { P2: 40000, P1: 38000 } }),
        b({ supplier_id: 'b', price_matrix: { P2: 52000, P1: 50000 } }),
      ]),
    );
    expect(r.chosenSupplierId).toBe('b');
    expect(r.patch.base_price_sen).toBe(52000);
    expect(r.patch.price1_sen).toBe(50000);
  });
});

describe('deriveProductCostFromSuppliers — SOFA (whole set, NOT per-cell max)', () => {
  it('takes the WHOLE grid from the single dearest supplier', () => {
    // Supplier A has the single dearest cell (300 at 24") but a cheap 28" (100).
    // Supplier B is uniformly 250. Owner rule: the whole set comes from the
    // dearest supplier (A), so 28" must be A's 100 — NOT B's 250 (per-cell max).
    const r = chosen(
      deriveProductCostFromSuppliers('SOFA', [
        b({ supplier_id: 'A', price_matrix: { '24': { P2: 300000 }, '28': { P2: 100000 } } }),
        b({ supplier_id: 'B', price_matrix: { '24': { P2: 250000 }, '28': { P2: 250000 } } }),
      ]),
    );
    expect(r.chosenSupplierId).toBe('A');
    const rows = r.patch.seat_height_prices ?? [];
    const cell = (h: string) => rows.find((x) => x.height === h && x.tier === 'PRICE_2')?.priceSen;
    expect(cell('24')).toBe(300000);
    expect(cell('28')).toBe(100000); // proves whole-set, not per-cell max
  });

  it('carries all three tiers of the chosen supplier and the flat fallback', () => {
    const r = chosen(
      deriveProductCostFromSuppliers('SOFA', [
        b({
          supplier_id: 'only',
          unit_price_sen: 111000,
          price_matrix: { '24': { P1: 280000, P2: 300000, P3: 350000 } },
        }),
      ]),
    );
    expect(r.patch.base_price_sen).toBe(111000); // flat fallback lane
    const rows = r.patch.seat_height_prices ?? [];
    expect(rows).toEqual(
      expect.arrayContaining([
        { height: '24', tier: 'PRICE_2', priceSen: 300000 },
        { height: '24', tier: 'PRICE_1', priceSen: 280000 },
        { height: '24', tier: 'PRICE_3', priceSen: 350000 },
      ]),
    );
  });
});

describe('deriveProductCostFromSuppliers — deterministic tie-breaks', () => {
  it('equal dearness -> the main supplier wins', () => {
    const r = chosen(
      deriveProductCostFromSuppliers('MATTRESS', [
        b({ supplier_id: 'zzz', unit_price_sen: 8000, is_main_supplier: false }),
        b({ supplier_id: 'aaa', unit_price_sen: 8000, is_main_supplier: true }),
      ]),
    );
    expect(r.chosenSupplierId).toBe('aaa');
  });

  it('equal dearness, neither main -> smaller supplier_id wins (stable)', () => {
    const r = chosen(
      deriveProductCostFromSuppliers('MATTRESS', [
        b({ supplier_id: 'sB', unit_price_sen: 8000 }),
        b({ supplier_id: 'sA', unit_price_sen: 8000 }),
      ]),
    );
    expect(r.chosenSupplierId).toBe('sA');
  });
});

describe('deriveProductCostFromSuppliers — zero-priced winner is reported, not hidden', () => {
  it('all suppliers zero-priced -> dearnessSen 0 so the caller can refuse to clobber', () => {
    const r = chosen(
      deriveProductCostFromSuppliers('MATTRESS', [
        b({ supplier_id: 's1', unit_price_sen: 0 }),
        b({ supplier_id: 's2', unit_price_sen: null }),
      ]),
    );
    expect(r.dearnessSen).toBe(0);
    expect(r.patch.base_price_sen).toBe(0);
  });
});

describe('deriveProductCostFromSuppliers — a cost-less binding never anchors cost (owner 2026-09-16)', () => {
  it('SOFA: a supplier with only P1 (no P2 anywhere, flat 0) does NOT win; cost comes from a P2 supplier (9058-L class)', () => {
    // ARMANI 9058-L is only-P1 with a 10405 outlier; the four agreeing suppliers
    // quote a real P2 cost. The dearest AMONG suppliers that quote a cost wins.
    const r = chosen(
      deriveProductCostFromSuppliers('SOFA', [
        b({ supplier_id: 'armani', unit_price_sen: 0, price_matrix: { '24': { P1: 1040500 }, '30': { P1: 110000 } } }),
        b({
          supplier_id: 'ohana',
          unit_price_sen: 0,
          price_matrix: { '24': { P2: 105000, P3: 110000 }, '30': { P2: 110000, P3: 115000 } },
        }),
      ]),
    );
    expect(r.chosenSupplierId).toBe('ohana'); // NOT armani
    expect(r.dearnessSen).toBe(115000); // RM1150 (dearest cell of the cost supplier), never 1040500
    const rows = r.patch.seat_height_prices ?? [];
    expect(rows.some((x) => x.priceSen === 1040500)).toBe(false); // the P1 outlier never leaks
    expect(rows.find((x) => x.height === '24' && x.tier === 'PRICE_2')?.priceSen).toBe(105000);
  });

  it('SOFA: when EVERY supplier is only-P1 (no cost tier anywhere) -> skipped, cost not fabricated', () => {
    const r = deriveProductCostFromSuppliers('SOFA', [
      b({ supplier_id: 'a', unit_price_sen: 0, price_matrix: { '24': { P1: 1040500 } } }),
    ]);
    expect(r.skipped).toBe(true);
    if (r.skipped) expect(r.reason).toBe('no_supplier_with_cost');
  });

  it('BEDFRAME: an only-P1 binding (no P2, no flat) cannot win and null the cost', () => {
    const r = chosen(
      deriveProductCostFromSuppliers('BEDFRAME', [
        b({ supplier_id: 'onlyP1', price_matrix: { P1: 299000 } }),
        b({ supplier_id: 'real', price_matrix: { P2: 55000 } }),
      ]),
    );
    expect(r.chosenSupplierId).toBe('real'); // NOT onlyP1
    expect(r.patch.base_price_sen).toBe(55000); // RM550, never null and never 2990
  });

  it('a binding that HAS a cost tier still ranks by its dearest cell (rule unchanged)', () => {
    // 'rich' has both a real P2 cost AND a high P1; it still participates and its
    // whole set (P2 cost) wins over the cheaper 'real' — the filter only removes
    // cost-less bindings, it does not change ranking for costed ones.
    const r = chosen(
      deriveProductCostFromSuppliers('BEDFRAME', [
        b({ supplier_id: 'real', price_matrix: { P2: 55000 } }),
        b({ supplier_id: 'rich', price_matrix: { P1: 299000, P2: 70000 } }),
      ]),
    );
    expect(r.chosenSupplierId).toBe('rich');
    expect(r.patch.base_price_sen).toBe(70000);
  });
});

describe('deriveProductCostFromSuppliers — BEDFRAME flat-priced (no matrix)', () => {
  it('derives base_price_sen from the flat unit_price_sen, not null (ELEPHANE-(SK) class)', () => {
    const r = deriveProductCostFromSuppliers('BEDFRAME', [
      b({ supplier_id: 'a', unit_price_sen: 165000, price_matrix: null }),
      b({ supplier_id: 'b', unit_price_sen: 160000, price_matrix: null }),
    ]);
    if (r.skipped) throw new Error('expected a patch');
    expect(r.chosenSupplierId).toBe('a');      // dearest flat
    expect(r.patch.base_price_sen).toBe(165000); // not null
  });
});
