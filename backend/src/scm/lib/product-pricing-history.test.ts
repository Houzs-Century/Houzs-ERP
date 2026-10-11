// Resolver tests for effective-dated product selling price (Pricing B, Phase 1).
// The fake `sb` implements the real query semantics (company+code filter,
// effective_from bound, multi-key order, limit 1) over an in-memory fixture, so
// these prove the owner's worked example (1/1=100, 3/1=200, 5/1=500) resolves to
// the price effective ON the document's date — and that an empty history falls
// back to null (the flat mfg_products price).
import { describe, expect, test } from 'vitest';
import {
  resolveSellPriceSenAsOf,
  resolvePendingSellPriceAfter,
} from './product-pricing-history';

type Row = {
  company_id: number;
  product_code: string;
  sell_price_sen: number | null;
  effective_from: string; // YYYY-MM-DD (lexicographic == chronological)
  created_at: string;      // ISO
};

/** Minimal supabase-js stand-in that honours .eq/.lte/.gt/.order/.limit and
 *  returns the first row of the resolved set from .maybeSingle(). */
function fakeSb(rows: Row[]) {
  return {
    from(_table: string) {
      const eqs: Record<string, unknown> = {};
      let lteCol: string | null = null, lteVal: string | null = null;
      let gtCol: string | null = null, gtVal: string | null = null;
      const orders: Array<{ col: keyof Row; asc: boolean }> = [];
      const b: any = {
        select() { return b; },
        eq(col: string, val: unknown) { eqs[col] = val; return b; },
        lte(col: string, val: string) { lteCol = col; lteVal = val; return b; },
        gt(col: string, val: string) { gtCol = col; gtVal = val; return b; },
        order(col: keyof Row, opts?: { ascending?: boolean }) {
          orders.push({ col, asc: opts?.ascending !== false });
          return b;
        },
        limit(_n: number) { return b; },
        async maybeSingle() {
          let res = rows.filter((r) =>
            Object.entries(eqs).every(([k, v]) => (r as any)[k] === v),
          );
          if (lteCol && lteVal != null) res = res.filter((r) => (r as any)[lteCol!] <= lteVal!);
          if (gtCol && gtVal != null) res = res.filter((r) => (r as any)[gtCol!] > gtVal!);
          res = [...res].sort((a, b2) => {
            for (const o of orders) {
              const av = a[o.col] as string | number;
              const bv = b2[o.col] as string | number;
              if (av < bv) return o.asc ? -1 : 1;
              if (av > bv) return o.asc ? 1 : -1;
            }
            return 0;
          });
          return { data: res[0] ?? null };
        },
      };
      return b;
    },
  };
}

const OWNER_EXAMPLE: Row[] = [
  { company_id: 1, product_code: 'SOFA-X', sell_price_sen: 10000, effective_from: '2026-01-01', created_at: '2026-01-01T00:00:00Z' },
  { company_id: 1, product_code: 'SOFA-X', sell_price_sen: 20000, effective_from: '2026-03-01', created_at: '2026-03-01T00:00:00Z' },
  { company_id: 1, product_code: 'SOFA-X', sell_price_sen: 50000, effective_from: '2026-05-01', created_at: '2026-05-01T00:00:00Z' },
];

describe('resolveSellPriceSenAsOf', () => {
  test("owner example: an order takes the price effective on ITS date", async () => {
    const sb = fakeSb(OWNER_EXAMPLE);
    expect(await resolveSellPriceSenAsOf(sb, 1, 'SOFA-X', '2026-02-10')).toBe(10000); // Jan price
    expect(await resolveSellPriceSenAsOf(sb, 1, 'SOFA-X', '2026-04-01')).toBe(20000); // Mar price
    expect(await resolveSellPriceSenAsOf(sb, 1, 'SOFA-X', '2026-06-01')).toBe(50000); // May price
    expect(await resolveSellPriceSenAsOf(sb, 1, 'SOFA-X', '2026-05-01')).toBe(50000); // boundary = inclusive
  });

  test('before the first scheduled date → null (caller uses the flat price)', async () => {
    const sb = fakeSb(OWNER_EXAMPLE);
    expect(await resolveSellPriceSenAsOf(sb, 1, 'SOFA-X', '2025-12-31')).toBeNull();
  });

  test('empty history → null (backward-compatible: identical to today)', async () => {
    expect(await resolveSellPriceSenAsOf(fakeSb([]), 1, 'SOFA-X', '2026-06-01')).toBeNull();
  });

  test('company-scoped: company 1 never sees company 2\'s schedule for the same code', async () => {
    const sb = fakeSb([
      ...OWNER_EXAMPLE,
      { company_id: 2, product_code: 'SOFA-X', sell_price_sen: 99900, effective_from: '2026-01-01', created_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(await resolveSellPriceSenAsOf(sb, 1, 'SOFA-X', '2026-06-01')).toBe(50000);
    expect(await resolveSellPriceSenAsOf(sb, 2, 'SOFA-X', '2026-06-01')).toBe(99900);
  });

  test('same effective_from → newest created_at wins (a same-day correction)', async () => {
    const sb = fakeSb([
      { company_id: 1, product_code: 'A', sell_price_sen: 30000, effective_from: '2026-03-01', created_at: '2026-02-01T09:00:00Z' },
      { company_id: 1, product_code: 'A', sell_price_sen: 31000, effective_from: '2026-03-01', created_at: '2026-02-01T15:00:00Z' },
    ]);
    expect(await resolveSellPriceSenAsOf(sb, 1, 'A', '2026-03-02')).toBe(31000);
  });

  test('guards: blank code / bad company → null', async () => {
    const sb = fakeSb(OWNER_EXAMPLE);
    expect(await resolveSellPriceSenAsOf(sb, 1, '  ', '2026-06-01')).toBeNull();
    expect(await resolveSellPriceSenAsOf(sb, 0, 'SOFA-X', '2026-06-01')).toBeNull();
  });
});

describe('resolvePendingSellPriceAfter', () => {
  test('returns the NEXT scheduled price strictly after asOf', async () => {
    const sb = fakeSb(OWNER_EXAMPLE);
    expect(await resolvePendingSellPriceAfter(sb, 1, 'SOFA-X', '2026-02-10'))
      .toEqual({ sellPriceSen: 20000, effectiveFrom: '2026-03-01' });
    expect(await resolvePendingSellPriceAfter(sb, 1, 'SOFA-X', '2026-03-01'))
      .toEqual({ sellPriceSen: 50000, effectiveFrom: '2026-05-01' });
  });

  test('no pending change after the last scheduled date → null', async () => {
    expect(await resolvePendingSellPriceAfter(fakeSb(OWNER_EXAMPLE), 1, 'SOFA-X', '2026-05-01')).toBeNull();
  });
});
