import { describe, it, expect } from 'vitest';
import { recomputeOneLine, type MfgItemForRecompute, type ProductRowLite } from './mfg-pricing-recompute';

// Stage 3c: recomputeOneLine overrides the product COST from the derived-cost
// history as-of the order date, but ONLY when the auto-derive flag is ON and an
// `asOf` is passed. Flag OFF / no asOf / no history row -> the flat product cost,
// byte-identical to before.

const product: ProductRowLite = {
  code: 'ACC-1', category: 'ACCESSORY',
  base_price_sen: 10000, price1_sen: null, cost_price_sen: 3000,
  seat_height_prices: null, base_model: null, sell_price_sen: 10000,
};
const line: MfgItemForRecompute = { itemCode: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: 5000, variants: {} };

/** Stub sb returning preset rows per table; supports the resolver chains
 *  (.eq/.lte/.order/.limit/.maybeSingle and awaiting the builder). */
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
      // no app_config row -> flag OFF
      mfg_product_cost_history: { base_price_sen: 15000, price1_sen: null, seat_height_prices: null },
    });
    const r = await recomputeOneLine(sb, line, null, 1, { asOf: '2026-03-01' });
    expect(r.unit_cost_sen).toBe(10000); // flat, history ignored while OFF
  });

  it('flag ON + asOf + history row: cost uses the as-of derived base', async () => {
    const sb = stubSb({
      mfg_products: prodRow,
      app_config: { value: 'on' },
      mfg_product_cost_history: { base_price_sen: 15000, price1_sen: null, seat_height_prices: null },
    });
    const r = await recomputeOneLine(sb, line, null, 1, { asOf: '2026-03-01' });
    expect(r.unit_cost_sen).toBe(15000); // overridden from history as-of the order date
  });

  it('flag ON + asOf but NO history row: falls back to the flat product cost', async () => {
    const sb = stubSb({
      mfg_products: prodRow,
      app_config: { value: 'on' },
      // no mfg_product_cost_history row
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
    const r = await recomputeOneLine(sb, line, null, 1); // no asOf
    expect(r.unit_cost_sen).toBe(10000);
  });
});
