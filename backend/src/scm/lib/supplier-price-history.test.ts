import { describe, expect, it } from 'vitest';
import { resolveSupplierPricesAsOf, resolveMfgProductCostAsOf } from './supplier-price-history';

// A fake `sb` that returns preset rows for the one table under test and records
// nothing else — the resolvers' filters/order are exercised against real prod
// by their indexes; here we test the JS shaping (per-supplier de-dup, mapping,
// null/empty handling, error -> throw).
function fakeSb(rows: unknown[], error: { message: string } | null = null) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.from = chain; b.select = chain; b.eq = chain; b.lte = chain;
  b.order = chain; b.limit = chain;
  b.maybeSingle = async () => ({ data: rows[0] ?? null, error });
  b.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error });
  return b;
}

describe('resolveSupplierPricesAsOf', () => {
  it('empty history -> [] (caller falls back to live bindings)', async () => {
    expect(await resolveSupplierPricesAsOf(fakeSb([]), 1, 'X', '2026-06-01')).toEqual([]);
  });

  it('takes the NEWEST row per supplier (rows arrive newest-first per supplier)', async () => {
    const rows = [
      { supplier_id: 'A', is_main_supplier: true, unit_price_sen: 9000, price_matrix: null, effective_from: '2026-05-01', created_at: '2' },
      { supplier_id: 'A', is_main_supplier: true, unit_price_sen: 5000, price_matrix: null, effective_from: '2026-01-01', created_at: '1' },
      { supplier_id: 'B', is_main_supplier: false, unit_price_sen: 7000, price_matrix: null, effective_from: '2026-03-01', created_at: '1' },
    ];
    const out = await resolveSupplierPricesAsOf(fakeSb(rows), 1, 'X', '2026-06-01');
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.supplier_id === 'A')?.unit_price_sen).toBe(9000); // newest, not 5000
    expect(out.find((s) => s.supplier_id === 'B')?.unit_price_sen).toBe(7000);
  });

  it('invalid args -> []', async () => {
    expect(await resolveSupplierPricesAsOf(fakeSb([{ supplier_id: 'A' }]), 0, 'X')).toEqual([]);
    expect(await resolveSupplierPricesAsOf(fakeSb([{ supplier_id: 'A' }]), 1, '')).toEqual([]);
  });

  it('read error -> throws (a failed read is not "no history")', async () => {
    await expect(resolveSupplierPricesAsOf(fakeSb([], { message: 'boom' }), 1, 'X')).rejects.toThrow(/history read failed/);
  });
});

describe('resolveMfgProductCostAsOf', () => {
  it('no row -> null (caller uses the flat product cost)', async () => {
    expect(await resolveMfgProductCostAsOf(fakeSb([]), 1, 'X', '2026-06-01')).toBeNull();
  });

  it('maps the as-of derived cost row', async () => {
    const row = { base_price_sen: 12345, price1_sen: 11000, seat_height_prices: [{ height: '24', tier: 'PRICE_2', priceSen: 12345 }] };
    const out = await resolveMfgProductCostAsOf(fakeSb([row]), 1, 'X', '2026-06-01');
    expect(out).toEqual(row);
  });

  it('coerces non-numeric price fields to null', async () => {
    const out = await resolveMfgProductCostAsOf(fakeSb([{ base_price_sen: null, price1_sen: undefined, seat_height_prices: null }]), 1, 'X');
    expect(out).toEqual({ base_price_sen: null, price1_sen: null, seat_height_prices: null });
  });

  it('read error -> throws', async () => {
    await expect(resolveMfgProductCostAsOf(fakeSb([], { message: 'boom' }), 1, 'X')).rejects.toThrow(/history read failed/);
  });
});
