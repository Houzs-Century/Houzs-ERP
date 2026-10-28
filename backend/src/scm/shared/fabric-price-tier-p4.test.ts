// 2990-0024: supplier sofa lists (THL / Raffreka) price every module at four
// grades: Fabric / Acacia / Half Leather / Full Leather. A sofa fabric set to
// Price 4 must cost at the supplier's P4 cell, not fall back to P2.

import { describe, it, expect } from 'vitest';
import { computeMfgPoUnitCost } from './mfg-pricing';
import { normalizeSofaTier } from './sofa-tier';
import { fabricTierAddon } from './fabric-tier-addon';

// 2377 (60cm) r1L from the THL list dated 22/10/2026: Acacia / HL / FL.
const MATRIX = { '24': { P2: 280000, P3: 296000, P4: 394000 } };

const poCost = (fabricTier: 'PRICE_2' | 'PRICE_3' | 'PRICE_4') => computeMfgPoUnitCost(
  { category: 'SOFA', priceMatrix: MATRIX, unitPriceSen: 0, fabricTier, seatSize: '24' },
  null,
).unitPriceSen;

describe('sofa Price 4 (Full Leather)', () => {
  it('a PO line costs at the tier it was picked at', () => {
    expect(poCost('PRICE_2')).toBe(280000);
    expect(poCost('PRICE_3')).toBe(296000);
    expect(poCost('PRICE_4')).toBe(394000);
  });

  it('the SKU import reads P4 / Price 4 as PRICE_4', () => {
    expect(normalizeSofaTier('P4')).toBe('PRICE_4');
    expect(normalizeSofaTier('Price 4')).toBe('PRICE_4');
    expect(normalizeSofaTier('5')).toBeNull();
  });

  it('carries no POS selling add-on (the POS has no PRICE_4 slot)', () => {
    const config = { sofaTier2Delta: 300, sofaTier3Delta: 600, bedframeTier2Delta: 150, bedframeTier3Delta: 250 };
    expect(fabricTierAddon('SOFA', 'PRICE_4', config)).toBe(0);
  });
});
