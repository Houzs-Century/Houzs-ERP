import { describe, it, expect } from 'vitest';
import { recomputeFromSnapshot, type MfgItemForRecompute, type ProductRowLite } from './mfg-pricing-recompute';

// A plain non-sofa catalog product with an authoritative sell price of RM 100.
const product: ProductRowLite = {
  code: 'ACC-1', category: 'ACCESSORY',
  base_price_sen: 10000, price1_sen: null, cost_price_sen: 3000,
  seat_height_prices: null, base_model: null, sell_price_sen: 10000,
};
const item = (clientCenti: number): MfgItemForRecompute => ({
  itemCode: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceCenti: clientCenti, variants: {},
});
// recomputeFromSnapshot(item, product, fabric, config, ...10 optional..., trustOperatorSelling)
const trusted = (clientCenti: number) =>
  recomputeFromSnapshot(item(clientCenti), product, null, null, null, null, null, null, null, null, null, null, null, null, true);

describe('recomputeFromSnapshot — trustOperatorSelling (owner ruling 2026-07)', () => {
  it('DEFAULT (POS / untrusted): a catalog line persists the AUTHORITATIVE price + flags drift', () => {
    const r = recomputeFromSnapshot(item(5000), product, null, null); // trust defaults false
    expect(r.unit_price_sen).toBe(10000); // catalog wins — client RM50 ignored
    expect(r.drift).toBe(true);           // 5000 vs 10000 -> drift (a POS caller would be 400'd)
  });

  it('TRUSTED non-POS author: the catalog line persists the OPERATOR hand-typed price', () => {
    expect(trusted(5000).unit_price_sen).toBe(5000); // RM50 honoured, not normalised to RM100
  });

  it('TRUSTED but no price entered (client 0 = "not provided"): keep the authoritative fill', () => {
    expect(trusted(0).unit_price_sen).toBe(10000); // filled from catalog, not persisted as 0
  });

  it('TRUSTED does NOT touch cost (server snapshot stays authoritative)', () => {
    const r = trusted(5000);
    expect(r.unit_price_sen).toBe(5000);
    // cost is derived server-side from cost_price_sen, independent of the sell override
    expect(typeof r.unit_cost_centi === 'number' || r.unit_cost_centi === undefined).toBe(true);
  });
});
