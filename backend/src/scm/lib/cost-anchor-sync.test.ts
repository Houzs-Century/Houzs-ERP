import { describe, expect, it } from 'vitest';
import {
  bindingToProductPatch,
  productToBindingPatch,
  type BindingCost,
  type ProductCost,
  type SyncResult,
} from './cost-anchor-sync';

// Narrow a SyncResult to its patch (or fail loudly) — keeps
// noUncheckedIndexedAccess / the discriminated union happy without inline casts.
function patchOf<P>(r: SyncResult<P>): P {
  if (r.skipped) throw new Error(`expected a patch, got skipped: ${r.reason}`);
  return r.patch;
}

// ─────────────────────────────────────────────────────────────────────────
// SOFA — the product record is authoritative (owner 2026-07-20 "我这用的是产品档").
// One-way: a product cost edit pushes into the binding; a binding edit does NOT
// flow back onto the product.
// ─────────────────────────────────────────────────────────────────────────
describe('productToBindingPatch — SOFA product cost propagates to the binding', () => {
  const sofaBinding: Pick<BindingCost, 'category' | 'price_matrix'> = {
    category: 'SOFA',
    // A stale binding matrix the product edit must overwrite, proving the drift
    // the fix closes: the binding was NOT tracking the product.
    price_matrix: { '24': { P2: 111111 }, '99': { P2: 222222 } },
  };

  it('mirrors the product seat_height_prices COST grid onto the binding price_matrix', () => {
    const product: ProductCost = {
      base_price_sen: 250000,
      price1_sen: null,
      seat_height_prices: [
        { height: '24', tier: 'PRICE_2', priceSen: 300000 },
        { height: '24', tier: 'PRICE_1', priceSen: 280000 },
        { height: '28', tier: 'PRICE_2', priceSen: 320000 },
      ],
    };
    const patch = patchOf(productToBindingPatch(product, sofaBinding));
    // The whole matrix is REPLACED from the product (stale '99' key dropped).
    expect(patch.price_matrix).toEqual({
      '24': { P2: 300000, P1: 280000 },
      '28': { P2: 320000 },
    });
    // Flat fallback lane tracks base_price_sen.
    expect(patch.unit_price_centi).toBe(250000);
  });

  it('a tier-less seat row defaults to P2 (PRICE_2), PRICE_3 maps to P3', () => {
    const product: ProductCost = {
      base_price_sen: null,
      price1_sen: null,
      seat_height_prices: [
        { height: '24', priceSen: 300000 }, // no tier → P2
        { height: '24', tier: 'PRICE_3', priceSen: 350000 },
      ],
    };
    const patch = patchOf(productToBindingPatch(product, sofaBinding));
    expect(patch.price_matrix).toEqual({ '24': { P2: 300000, P3: 350000 } });
    // base_price_sen null → the flat lane is left untouched (not forced to 0).
    expect(patch.unit_price_centi).toBeUndefined();
  });

  it('MONEY-SAFE: a seat row with no priceSen (selling-only) is skipped, never mirrored as 0', () => {
    const product: ProductCost = {
      base_price_sen: 250000,
      price1_sen: null,
      // priceSen absent = no cost on this slot (a POS selling-only row).
      seat_height_prices: [{ height: '24', tier: 'PRICE_2' }],
    };
    const patch = patchOf(productToBindingPatch(product, sofaBinding));
    // No priced row → matrix untouched (NOT wiped, NOT zero-filled); only the
    // flat fallback follows base_price_sen.
    expect(patch.price_matrix).toBeUndefined();
    expect(patch.unit_price_centi).toBe(250000);
  });

  it('MONEY-SAFE: a product with NO sofa cost at all does not wipe the binding (skipped)', () => {
    const product: ProductCost = {
      base_price_sen: null,
      price1_sen: null,
      seat_height_prices: [],
    };
    const result = productToBindingPatch(product, sofaBinding);
    expect(result.skipped).toBe(true);
    // Empty patch → caller writes nothing → the binding's existing cost survives.
    expect(result).toEqual({ skipped: true, reason: 'sofa_product_has_no_cost' });
  });
});

describe('bindingToProductPatch — SOFA stays one-way (a supplier edit cannot overwrite the product)', () => {
  it('a supplier-side sofa binding cost edit is skipped, leaving the product authoritative', () => {
    const binding: BindingCost = {
      category: 'SOFA',
      unit_price_centi: 999999,
      price_matrix: { '24': { P2: 999999 } },
    };
    const result = bindingToProductPatch(binding);
    expect(result.skipped).toBe(true);
    expect(result).toEqual({ skipped: true, reason: 'sofa_product_is_authoritative' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-sofa sync must remain bidirectional and unchanged by this fix.
// ─────────────────────────────────────────────────────────────────────────
describe('non-sofa sync is unchanged (bidirectional)', () => {
  it('FLAT (mattress) binding→product mirrors unit_price_centi to base_price_sen', () => {
    const patch = patchOf(
      bindingToProductPatch({ category: 'MATTRESS', unit_price_centi: 12345, price_matrix: null }),
    );
    expect(patch.base_price_sen).toBe(12345);
  });

  it('FLAT (mattress) product→binding mirrors base_price_sen to unit_price_centi', () => {
    const patch = patchOf(
      productToBindingPatch(
        { base_price_sen: 12345, price1_sen: null },
        { category: 'MATTRESS', price_matrix: null },
      ),
    );
    expect(patch.unit_price_centi).toBe(12345);
    // Flat categories never touch the matrix.
    expect(patch.price_matrix).toBeUndefined();
  });

  it('BEDFRAME binding→product mirrors matrix P2/P1 to base_price_sen/price1_sen', () => {
    const patch = patchOf(
      bindingToProductPatch({ category: 'BEDFRAME', unit_price_centi: null, price_matrix: { P2: 5000, P1: 4000 } }),
    );
    expect(patch.base_price_sen).toBe(5000);
    expect(patch.price1_sen).toBe(4000);
  });

  it('BEDFRAME product→binding mirrors base_price_sen/price1_sen onto matrix P2/P1', () => {
    const patch = patchOf(
      productToBindingPatch(
        { base_price_sen: 5000, price1_sen: 4000 },
        { category: 'BEDFRAME', price_matrix: {} },
      ),
    );
    expect(patch.price_matrix).toEqual({ P2: 5000, P1: 4000 });
  });
});
