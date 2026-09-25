import { describe, expect, it } from 'vitest';
import {
  autoDeriveEnabled,
  mergeRetailOntoDerivedSeatGrid,
  recomputeDerivedProductCost,
  recordSupplierPriceHistorySafe,
  type DerivedCostIO,
} from './auto-derive-cost';
import type { SupplierBindingCost } from './derive-product-cost-from-suppliers';

// ── autoDeriveEnabled — the inert-by-default, SINGLE GLOBAL flag ───────────
/** scm.app_config's primary key is (key) alone, so this flag is one row for the
 *  whole database. The fake answers with `row` for the key regardless of company
 *  (the reader no longer filters by company_id), which is what makes the "one ON
 *  row arms both companies" test below meaningful. */
function fakeConfigSb(row: { value: unknown } | null, error = false) {
  const chain: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
    eq: () => chain,
    maybeSingle: async () => {
      if (error) return { data: null, error: { message: 'boom' } };
      return { data: row, error: null };
    },
  };
  return { from: () => ({ select: () => chain }) };
}

describe('autoDeriveEnabled — OFF unless explicitly on', () => {
  it('missing config row -> OFF (inert default)', async () => {
    expect(await autoDeriveEnabled(fakeConfigSb(null), 1)).toBe(false);
  });
  it("'on' / '1' / 'true' -> ON", async () => {
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'on' }), 1)).toBe(true);
    expect(await autoDeriveEnabled(fakeConfigSb({ value: '1' }), 1)).toBe(true);
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'TRUE' }), 1)).toBe(true);
  });
  it("'off' / anything else -> OFF", async () => {
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'off' }), 1)).toBe(false);
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'yes-please' }), 1)).toBe(false);
  });
  it('read error -> OFF (fails closed, stays on today behaviour)', async () => {
    expect(await autoDeriveEnabled(fakeConfigSb(null, true), 1)).toBe(false);
  });

  /* Owner 2026-09-25: both companies must behave the same. The flag is one row
     for the whole database (app_config PK is (key) alone), so one ON row arms
     BOTH companies. This is safe now because retail is defended on the write
     path (mergeRetailOntoDerivedSeatGrid) and by company 2's DB trigger
     (trg_mfg_products_retail_price_lock) — not by hiding the switch. */
  it('one ON row arms BOTH companies (single global switch)', async () => {
    const sb = fakeConfigSb({ value: 'on' });
    expect(await autoDeriveEnabled(sb, 1)).toBe(true);
    expect(await autoDeriveEnabled(sb, 2)).toBe(true);
  });
  it('no company -> OFF (no company context, no derive)', async () => {
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'on' }), null)).toBe(false);
    expect(await autoDeriveEnabled(fakeConfigSb({ value: 'on' }), undefined)).toBe(false);
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

// ── mergeRetailOntoDerivedSeatGrid — the cost/retail boundary ────────────────
/* seat_height_prices is one jsonb array with two owners per (height, tier):
   priceSen = COST (derived here), sellingPriceSen = RETAIL (2990's POS SKU
   Master only). writeProductCost used to assign the derived array outright,
   which deleted every retail price it did not happen to restate — 193 of them
   across 82 company-2 SKUs between 2026-09-16 and 09-20. These assertions are
   the same rule the company-2 database trigger enforces (migration
   20260920T1300), so app and database cannot drift apart silently. */
describe('mergeRetailOntoDerivedSeatGrid', () => {
  const stored = [
    { height: '24', tier: 'PRICE_2', priceSen: 51975, sellingPriceSen: 99000 },
    { height: '28', tier: 'PRICE_1', sellingPriceSen: 149000 },
    { height: '30', tier: 'PRICE_2', priceSen: 62370 },
  ];

  it('carries the retail price onto a cost-only derived slot', () => {
    const out = mergeRetailOntoDerivedSeatGrid(stored, [
      { height: '24', tier: 'PRICE_2', priceSen: 60000 },
    ]);
    expect(out).toContainEqual({ height: '24', tier: 'PRICE_2', priceSen: 60000, sellingPriceSen: 99000 });
  });

  it('re-appends a retail slot the derived grid dropped entirely', () => {
    const out = mergeRetailOntoDerivedSeatGrid(stored, [
      { height: '24', tier: 'PRICE_2', priceSen: 60000 },
    ]);
    expect(out).toContainEqual({ height: '28', tier: 'PRICE_1', sellingPriceSen: 149000 });
  });

  it('NEVER loses a retail price, whatever the derivation sends', () => {
    const retail = (rows: unknown[]) =>
      rows.filter((r) => typeof (r as { sellingPriceSen?: unknown }).sellingPriceSen === 'number').length;
    for (const derived of [[], [{ height: '99', tier: 'PRICE_2', priceSen: 1 }], null, undefined, 'nonsense']) {
      expect(retail(mergeRetailOntoDerivedSeatGrid(stored, derived))).toBe(retail(stored));
    }
  });

  it('replaces the COST freely — cost is the derivation to own', () => {
    const out = mergeRetailOntoDerivedSeatGrid(stored, [
      { height: '24', tier: 'PRICE_2', priceSen: 77777 },
    ]);
    expect(out.find((r) => r.height === '24')?.priceSen).toBe(77777);
    // a dropped cost slot stays dropped; only its retail comes back
    expect(out.find((r) => r.height === '30')).toBeUndefined();
  });

  it('honours a retail price the derivation explicitly names (it never does today)', () => {
    const out = mergeRetailOntoDerivedSeatGrid(stored, [
      { height: '24', tier: 'PRICE_2', priceSen: 1, sellingPriceSen: 123456 },
    ]);
    expect(out[0]!.sellingPriceSen).toBe(123456);
  });

  it('keeps an explicit null as cleared, and does not resurrect it as a slot', () => {
    const cleared = [{ height: '24', tier: 'PRICE_1', sellingPriceSen: null }];
    // present in the derived grid: the stored null carries across
    expect(mergeRetailOntoDerivedSeatGrid(cleared, [{ height: '24', tier: 'PRICE_1', priceSen: 5 }]))
      .toEqual([{ height: '24', tier: 'PRICE_1', priceSen: 5, sellingPriceSen: null }]);
    // absent from it: nothing worth putting back
    expect(mergeRetailOntoDerivedSeatGrid(cleared, [])).toEqual([]);
  });

  it('treats a missing tier as PRICE_2 on both sides', () => {
    const out = mergeRetailOntoDerivedSeatGrid(
      [{ height: '24', sellingPriceSen: 99000 }],
      [{ height: '24', tier: 'PRICE_2', priceSen: 100 }],
    );
    expect(out).toEqual([{ height: '24', tier: 'PRICE_2', priceSen: 100, sellingPriceSen: 99000 }]);
  });
});
