import { describe, it, expect } from 'vitest';
import { productSchema } from './product';

// Minimal valid sofa SKU input. The ≥1-active rules live on the OUTER
// productSchema.superRefine, so tests parse through productSchema (not the bare
// sofaProductSchema). bundles/compartments are valid so each test isolates the
// fabric rule.
const base = {
  pricingKind: 'sofa_build' as const,
  sku: 'SOF-TEST', categoryId: 'sofa', seriesId: null,
  name: 'Test', detail: null, sizeDisplay: null, depthOptions: '24',
  imgKey: null, thumbKey: null, stock: 0, lowAt: 5, visible: true, includedAddons: [],
  reclinerUpgradePrice: 0,
  compartments: [{ compartmentId: '1A(LHF)', active: true, price: 100 }],
  bundles: [{ bundleId: '2S', active: true, price: 1990 }],
};

describe('productSchema sofa fabrics', () => {
  it('requires at least one active fabric', () => {
    const bad = { ...base, fabrics: [{ fabricId: 'linen', active: false, surcharge: 0 }] };
    expect(productSchema.safeParse(bad).success).toBe(false);
  });

  it('passes with an active fabric', () => {
    const ok = { ...base, fabrics: [{ fabricId: 'linen', active: true, surcharge: 0 }] };
    expect(productSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects a sofa with no fabrics array at all', () => {
    expect(productSchema.safeParse(base).success).toBe(false);
  });
});
