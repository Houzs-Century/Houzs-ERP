import { describe, it, expect } from 'vitest';
import { recomputeOneLine, type MfgItemForRecompute, type ProductRowLite } from './mfg-pricing-recompute';


const product: ProductRowLite = {
  code: 'ACC-1', category: 'ACCESSORY',
  base_price_sen: 10000, price1_sen: null, cost_price_sen: 3000,
  seat_height_prices: null, base_model: null, sell_price_sen: 10000,
};
const line: MfgItemForRecompute = { itemCode: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: 5000, variants: {} };

function stubSb(rowsByTable: Record<string, unknown>) {
  const builder = (table: string) => {
    const row = rowsByTable[table];
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain, in: () => chain, is: () => chain, not: () => chain,
      gt: () => chain, lte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: Array.isArray(row) ? (row[0] ?? null) : (row ?? null), error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: Array.isArray(row) ? row : (row ? [row] : []), error: null }),
    };
    return chain;
  };
  return { from: (t: string) => builder(t) };
}

const prodRow = { ...product, pwp_price_sen: null, model_id: null, size_code: null, branding: null, default_free_gifts: null };

describe('recomputeOneLine — as-of cost override (stage 3c, flag-gated)', () => {
  it('flag OFF: cost uses the flat product base, even with asOf', async () => {
    const sb = stubSb({
      mfg_products: prodRow,
      mfg_product_cost_history: { base_price_sen: 15000, price1_sen: null, seat_height_prices: null },
    });
    const r = await recomputeOneLine(sb, line, null, 1, { asOf: '2026-03-01' });
    expect(r.unit_cost_sen).toBe(10000);
  });

  it('flag ON + asOf + history row: cost uses the as-of derived base', async () => {
    const sb = stubSb({
      mfg_products: prodRow,
      app_config: { value: 'on' },
      mfg_product_cost_history: { base_price_sen: 15000, price1_sen: null, seat_height_prices: null },
    });
    const r = await recomputeOneLine(sb, line, null, 1, { asOf: '2026-03-01' });
    expect(r.unit_cost_sen).toBe(15000);
  });

  it('flag ON + asOf but NO history row: falls back to the flat product cost', async () => {
    const sb = stubSb({
      mfg_products: prodRow,
      app_config: { value: 'on' },
    });
    const r = await recomputeOneLine(sb, line, null, 1, { asOf: '2026-03-01' });
    expect(r.unit_cost_sen).toBe(10000);
  });

  it('flag ON but NO asOf: override is skipped (needs an order date)', async () => {
    const sb = stubSb({
      mfg_products: prodRow,
      app_config: { value: 'on' },
      mfg_product_cost_history: { base_price_sen: 15000, price1_sen: null, seat_height_prices: null },
    });
    const r = await recomputeOneLine(sb, line, null, 1);
    expect(r.unit_cost_sen).toBe(10000);
  });
});
