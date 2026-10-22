import { describe, expect, it } from 'vitest';
import { applyDueSupplierPrices, pickDueSupplierPrice, type SupplierPriceHistoryRow } from './supplier-price-apply';

const row = (over: Partial<SupplierPriceHistoryRow>): SupplierPriceHistoryRow => ({
  id: 'h', company_id: 1, supplier_id: 'sup-a', material_kind: 'mfg_product', item_code: 'ULT-K',
  unit_price_sen: 0, price_matrix: null, effective_from: '2026-06-01', created_at: '2026-06-01T00:00:00Z',
  applied_at: null, ...over,
});

describe('pickDueSupplierPrice', () => {
  const baseline = row({ id: 'base', unit_price_sen: 155000, effective_from: '2026-06-01', applied_at: '2026-06-01T00:00:00Z' });
  const oct = row({ id: 'oct', unit_price_sen: 175000, effective_from: '2026-10-01', created_at: '2026-09-20T00:00:00Z' });

  it('before the date: nothing is due', () => {
    expect(pickDueSupplierPrice([baseline, oct], '2026-09-30')).toEqual({ apply: null, markApplied: [] });
  });

  it('on the date: the scheduled price goes live', () => {
    const r = pickDueSupplierPrice([baseline, oct], '2026-10-01');
    expect(r.apply?.unit_price_sen).toBe(175000);
    expect(r.markApplied).toEqual(['oct']);
  });

  it('a later direct edit supersedes an overdue schedule: marked, not applied', () => {
    const edit = row({ id: 'edit', unit_price_sen: 160000, effective_from: '2026-10-05', created_at: '2026-10-05T00:00:00Z', applied_at: '2026-10-05T00:00:00Z' });
    expect(pickDueSupplierPrice([baseline, oct, edit], '2026-10-06')).toEqual({ apply: null, markApplied: ['oct'] });
  });

  it('two schedules on one day: the one recorded last wins', () => {
    const again = row({ id: 'again', unit_price_sen: 180000, effective_from: '2026-10-01', created_at: '2026-09-25T00:00:00Z' });
    const r = pickDueSupplierPrice([baseline, again, oct], '2026-10-01');
    expect(r.apply?.id).toBe('again');
    expect(r.markApplied.sort()).toEqual(['again', 'oct']);
  });
});

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Minimal filtering fake: eq / in / lte / is, update applies to matching rows.
function fakeSb(tables: Record<string, Row[]>) {
  return {
    from(t: string) {
      const rows = (tables[t] ||= []);
      const preds: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      const q: Row = {
        select: () => q, order: () => q, limit: () => q, range: () => q, filter: () => q,
        insert: (r: Row) => { rows.push(r); return Promise.resolve({ error: null }); },
        update: (p: Row) => { patch = p; return q; },
        eq: (c: string, v: unknown) => { preds.push((r) => String(r[c]) === String(v)); return q; },
        in: (c: string, vs: unknown[]) => { const s = new Set(vs.map(String)); preds.push((r) => s.has(String(r[c]))); return q; },
        lte: (c: string, v: string) => { preds.push((r) => r[c] <= v); return q; },
        is: (c: string, v: null) => { preds.push((r) => (r[c] ?? null) === v); return q; },
        maybeSingle: async () => ({ data: rows.filter((r) => preds.every((p) => p(r)))[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => {
          const hit = rows.filter((r) => preds.every((p) => p(r)));
          if (patch) for (const r of hit) Object.assign(r, patch);
          return Promise.resolve({ data: hit, error: null }).then(res);
        },
      };
      return q;
    },
  };
}

describe('applyDueSupplierPrices', () => {
  const seed = (flag: string | null) => ({
    app_config: flag ? [{ key: 'scm.auto_derive_product_cost', value: flag }] : [],
    mfg_products: [{ id: 'p1', company_id: 1, code: 'ULT-K', category: 'MATTRESS', base_price_sen: 155000 }],
    supplier_material_bindings: [
      { id: 'b-a', company_id: 1, supplier_id: 'sup-a', material_kind: 'mfg_product', item_code: 'ULT-K', unit_price_sen: 155000, price_matrix: null, is_main_supplier: true },
      { id: 'b-b', company_id: 1, supplier_id: 'sup-b', material_kind: 'mfg_product', item_code: 'ULT-K', unit_price_sen: 150000, price_matrix: null, is_main_supplier: false },
    ],
    supplier_binding_price_history: [
      row({ id: 'base', unit_price_sen: 155000, effective_from: '2026-09-20', created_at: '2026-09-20T00:00:00Z', applied_at: '2026-09-20T00:00:00Z' }),
      row({ id: 'oct', unit_price_sen: 175000, effective_from: '2026-10-01', created_at: '2026-09-20T00:00:01Z' }),
    ] as Row[],
    mfg_product_cost_history: [] as Row[],
  });

  it('30 Sep: the 1 Oct price is not applied yet', async () => {
    const t = seed('on');
    const r = await applyDueSupplierPrices(fakeSb(t), { today: '2026-09-30' });
    expect(r).toEqual({ bindings: 0, applied: 0, failed: 0 });
    expect(t.supplier_material_bindings[0].unit_price_sen).toBe(155000);
    expect(t.mfg_products[0].base_price_sen).toBe(155000);
  });

  it('1 Oct: the binding (PO price) and the product cost (highest supplier) both move, with a dated record', async () => {
    const t = seed('on');
    const r = await applyDueSupplierPrices(fakeSb(t), { today: '2026-10-01' });
    expect(r).toEqual({ bindings: 1, applied: 1, failed: 0 });
    expect(t.supplier_material_bindings[0].unit_price_sen).toBe(175000);
    expect(t.supplier_material_bindings[1].unit_price_sen).toBe(150000);
    expect(t.supplier_binding_price_history.find((h) => h.id === 'oct')!.applied_at).toBeTruthy();
    expect(t.mfg_products[0].base_price_sen).toBe(175000);
    expect(t.mfg_product_cost_history).toHaveLength(1);
    expect(t.mfg_product_cost_history[0]).toMatchObject({ base_price_sen: 175000, source_supplier_id: 'sup-a' });

    // A second run the same night is a no-op.
    expect(await applyDueSupplierPrices(fakeSb(t), { today: '2026-10-01' })).toEqual({ bindings: 0, applied: 0, failed: 0 });
  });

  it('auto-derive off: the binding still moves, the product cost is left alone', async () => {
    const t = seed(null);
    await applyDueSupplierPrices(fakeSb(t), { today: '2026-10-01' });
    expect(t.supplier_material_bindings[0].unit_price_sen).toBe(175000);
    expect(t.mfg_products[0].base_price_sen).toBe(155000);
  });
});
