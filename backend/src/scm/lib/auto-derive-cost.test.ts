import { describe, expect, it } from 'vitest';
import {
  autoDeriveEnabled,
  recomputeDerivedProductCost,
  recordSupplierPriceHistorySafe,
  type DerivedCostIO,
} from './auto-derive-cost';
import type { SupplierBindingCost } from './derive-product-cost-from-suppliers';

// ── autoDeriveEnabled — the inert-by-default flag ────────────────────────────
function fakeConfigSb(row: { value: unknown } | null, error = false) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (error ? { data: null, error: { message: 'boom' } } : { data: row, error: null }),
        }),
      }),
    }),
  };
}

describe('autoDeriveEnabled — OFF unless explicitly on', () => {
  it('missing config row -> OFF (inert default)', async () => {
    expect(await autoDeriveEnabled(fakeConfigSb(null))).toBe(false);
  });
  it("'on' / '1' / 'true' -> ON", async () => {
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'on' }))).toBe(true);
    expect(await autoDeriveEnabled(fakeConfigSb({ value: '1' }))).toBe(true);
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'TRUE' }))).toBe(true);
  });
  it("'off' / anything else -> OFF", async () => {
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'off' }))).toBe(false);
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'yes-please' }))).toBe(false);
  });
  it('read error -> OFF (fails closed, stays on today behaviour)', async () => {
    expect(await autoDeriveEnabled(fakeConfigSb(null, true))).toBe(false);
  });
});

// ── recomputeDerivedProductCost — the orchestrator over an injected IO ───────
function fakeIo(opts: {
  category?: string | null;
  productMissing?: boolean;
  bindings?: SupplierBindingCost[];
  latest?: { base_price_sen: number | null; price1_sen: number | null; seat_height_prices: unknown } | null;
}): {
  io: DerivedCostIO;
  writes: { id: string; patch: unknown }[];
  history: { patch: unknown; sourceSupplierId: string; effectiveFrom: string }[];
} {
  const writes: { id: string; patch: unknown }[] = [];
  const history: { patch: unknown; sourceSupplierId: string; effectiveFrom: string }[] = [];
  return {
    writes,
    history,
    io: {
      loadProduct: async () => (opts.productMissing ? null : { id: 'p1', category: opts.category ?? 'MATTRESS' }),
      loadBindings: async () => opts.bindings ?? [],
      writeProductCost: async (id, patch) => { writes.push({ id, patch }); },
      latestCostHistory: async () => opts.latest ?? null,
      appendCostHistory: async (_c, _code, patch, sourceSupplierId, effectiveFrom) => {
        history.push({ patch, sourceSupplierId, effectiveFrom });
      },
    },
  };
}
const b = (o: Partial<SupplierBindingCost> & { supplier_id: string }): SupplierBindingCost => ({
  is_main_supplier: false, unit_price_sen: null, price_matrix: null, ...o,
});

describe('recomputeDerivedProductCost', () => {
  it('writes the MAX-supplier cost onto the product', async () => {
    const { io, writes } = fakeIo({
      category: 'MATTRESS',
      bindings: [b({ supplier_id: 'a', unit_price_sen: 5000 }), b({ supplier_id: 'b', unit_price_sen: 9000 })],
    });
    const r = await recomputeDerivedProductCost(io, 1, 'X');
    expect(r).toMatchObject({ written: true, chosenSupplierId: 'b' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: 'p1', patch: { base_price_sen: 9000 } });
  });

  it('no binding -> does NOT write (the gap case), leaves the cost untouched', async () => {
    const { io, writes } = fakeIo({ bindings: [] });
    const r = await recomputeDerivedProductCost(io, 1, 'X');
    expect(r).toEqual({ written: false, reason: 'no_supplier_binding' });
    expect(writes).toHaveLength(0);
  });

  it('all suppliers zero-priced -> does NOT clobber a real cost with 0', async () => {
    const { io, writes } = fakeIo({
      bindings: [b({ supplier_id: 'a', unit_price_sen: 0 }), b({ supplier_id: 'b', unit_price_sen: null })],
    });
    const r = await recomputeDerivedProductCost(io, 1, 'X');
    expect(r).toEqual({ written: false, reason: 'all_zero_priced' });
    expect(writes).toHaveLength(0);
  });

  it('product not found -> no write', async () => {
    const { io, writes } = fakeIo({ productMissing: true, bindings: [b({ supplier_id: 'a', unit_price_sen: 5000 })] });
    const r = await recomputeDerivedProductCost(io, 1, 'X');
    expect(r).toEqual({ written: false, reason: 'product_not_found' });
    expect(writes).toHaveLength(0);
  });

  it('SOFA: rebuilds the product seat grid from the dearest supplier matrix', async () => {
    const { io, writes } = fakeIo({
      category: 'SOFA',
      bindings: [
        b({ supplier_id: 'lo', price_matrix: { '24': { P2: 100000 } } }),
        b({ supplier_id: 'hi', price_matrix: { '24': { P2: 300000 }, '28': { P2: 90000 } } }),
      ],
    });
    const r = await recomputeDerivedProductCost(io, 1, 'SOFA-X');
    expect(r).toMatchObject({ written: true, chosenSupplierId: 'hi' });
    const patch = writes[0].patch as { seat_height_prices?: { height: string; tier?: string; priceSen?: number }[] };
    const cell = (h: string) => patch.seat_height_prices?.find((x) => x.height === h && x.tier === 'PRICE_2')?.priceSen;
    expect(cell('24')).toBe(300000);
    expect(cell('28')).toBe(90000); // whole set from 'hi', not per-cell max
  });
});

describe('recomputeDerivedProductCost — as-of history timeline (stage 3b)', () => {
  it('appends a cost-history row when the derived cost is new (no prior history)', async () => {
    const { io, history } = fakeIo({
      bindings: [b({ supplier_id: 'a', unit_price_sen: 9000 })],
      latest: null,
    });
    await recomputeDerivedProductCost(io, 1, 'X');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ sourceSupplierId: 'a', patch: { base_price_sen: 9000 } });
    expect(history[0].effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does NOT append when the derived cost equals the latest history row (dedup)', async () => {
    const { io, history } = fakeIo({
      bindings: [b({ supplier_id: 'a', unit_price_sen: 9000 })],
      latest: { base_price_sen: 9000, price1_sen: null, seat_height_prices: null },
    });
    await recomputeDerivedProductCost(io, 1, 'X');
    expect(history).toHaveLength(0);
  });

  it('appends when the latest history differs (a real price move)', async () => {
    const { io, history } = fakeIo({
      bindings: [b({ supplier_id: 'a', unit_price_sen: 9500 })],
      latest: { base_price_sen: 9000, price1_sen: null, seat_height_prices: null },
    });
    await recomputeDerivedProductCost(io, 1, 'X');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ patch: { base_price_sen: 9500 } });
  });
});

// ── recordSupplierPriceHistorySafe — the supplier source timeline (stage 3b-supplier) ──
function histSb(latest: unknown) {
  const inserts: Record<string, unknown>[] = [];
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data: latest, error: null }),
    insert: async (row: Record<string, unknown>) => { inserts.push(row); return { error: null }; },
  };
  return { sb: { from: () => chain }, inserts };
}
const args = (unitPriceSen: number) => ({
  companyId: 1, supplierId: 'sup-1', itemCode: 'X',
  unitPriceSen, priceMatrix: null, isMainSupplier: true, effectiveFrom: '2026-05-01',
});

describe('recordSupplierPriceHistorySafe — dedup', () => {
  it('no prior row -> appends a snapshot', async () => {
    const { sb, inserts } = histSb(null);
    await recordSupplierPriceHistorySafe(sb, args(9000));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ supplier_id: 'sup-1', item_code: 'X', unit_price_sen: 9000, effective_from: '2026-05-01' });
  });

  it('unchanged price -> appends nothing', async () => {
    const { sb, inserts } = histSb({ unit_price_sen: 9000, price_matrix: null });
    await recordSupplierPriceHistorySafe(sb, args(9000));
    expect(inserts).toHaveLength(0);
  });

  it('changed price -> appends the new snapshot', async () => {
    const { sb, inserts } = histSb({ unit_price_sen: 9000, price_matrix: null });
    await recordSupplierPriceHistorySafe(sb, args(9500));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ unit_price_sen: 9500 });
  });
});
