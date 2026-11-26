// Owner 2026-11-23, rule 2 for a sofa set: a product change after the order's
// opening day prices on the change day. With a set price for the whole new
// combination standing that day, the set takes it; with none, the unchanged pieces
// keep the order-date cost and the added or changed ones take their own
// change-day cost. Shapes follow real combo rows; every amount is made up.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planChangedSetCost, type ChangedSetPiece } from './sofa-combo-cost-spread';
import type { SofaComboRow } from '../shared/sofa-combo-pricing';

const combo = (id: string, modules: string[][], sen: number, createdAt: string, deletedAt: string | null = null): SofaComboRow => ({
  id, baseModel: 'M100', modules, tier: 'PRICE_2', customerId: null, pricesByHeight: { 28: sen },
  effectiveFrom: createdAt.slice(0, 10), createdAt, deletedAt,
});
const piece = (id: string, code: string, own: number, unchanged: boolean): ChangedSetPiece => ({
  id, item_code: code, item_group: 'sofa', variants: { seatHeight: '28', fabricCode: 'F1' }, qty: 1,
  line_cost_sen: own, own_cost_sen: own, unchanged,
});
const PRICE_2 = () => 'PRICE_2' as const;
const ORDER = '2026-10-01';
const CHANGE = '2026-11-05';
const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);

const TWO = combo('two', [['1A(LHF)', '1A(RHF)'], ['2A(LHF)', '2A(RHF)']], 100000, '2026-09-01T02:00:00Z');
const THREE = combo('three', [['1A(LHF)', '1A(RHF)'], ['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], 150000, '2026-11-01T02:00:00Z');

describe('planChangedSetCost', () => {
  it('a set price for the whole new combination on the change day prices the whole set', () => {
    const plan = planChangedSetCost(
      [piece('a', 'M100-1A(LHF)', 50000, true), piece('b', 'M100-2A(RHF)', 70000, true), piece('c', 'M100-L(LHF)', 80000, false)],
      [TWO, THREE], PRICE_2, CHANGE, ORDER,
    );
    expect(sum(plan)).toBe(150000);
    expect(plan.size).toBe(3);
  });

  it('none for the new combination: the unchanged pieces keep the order-date set price, the added piece its own cost', () => {
    const plan = planChangedSetCost(
      [piece('a', 'M100-1A(LHF)', 50000, true), piece('b', 'M100-2A(RHF)', 70000, true), piece('c', 'M100-L(LHF)', 80000, false)],
      [TWO], PRICE_2, CHANGE, ORDER,
    );
    expect((plan.get('a') ?? 0) + (plan.get('b') ?? 0)).toBe(100000);
    expect(plan.get('c')).toBe(80000);
  });

  it('a piece taken off: the pieces left go back to their own order-date cost when no set price covers them', () => {
    const plan = planChangedSetCost([piece('a', 'M100-1A(LHF)', 50000, true), piece('c', 'M100-L(LHF)', 80000, true)], [TWO, THREE], PRICE_2, CHANGE, ORDER);
    expect(plan.get('a')).toBe(50000);
    expect(plan.get('c')).toBe(80000);
  });

  it('a set price created after the change day never counts', () => {
    const later = combo('later', THREE.modules, 140000, '2026-11-10T02:00:00Z');
    const plan = planChangedSetCost(
      [piece('a', 'M100-1A(LHF)', 50000, true), piece('b', 'M100-2A(RHF)', 70000, true), piece('c', 'M100-L(LHF)', 80000, false)],
      [TWO, later], PRICE_2, CHANGE, ORDER,
    );
    expect(plan.get('c')).toBe(80000);
    expect((plan.get('a') ?? 0) + (plan.get('b') ?? 0)).toBe(100000);
  });
});

const ownCost = vi.hoisted(() => new Map<string, number>());
vi.mock('./mfg-pricing-recompute', () => ({
  loadMaintenanceConfig: vi.fn(async () => null),
  recomputeOneLine: vi.fn(async (_sb: unknown, item: { itemCode: string }, _c: unknown, _co: unknown, opts: { asOf?: string }) => ({
    unit_cost_sen: ownCost.get(`${item.itemCode}@${opts.asOf}`) ?? 0,
  })),
}));
const { costChangedSofaSets } = await import('./so-set-change-cost');

function stub(lines: Array<Record<string, unknown>>, combos: SofaComboRow[]) {
  const writes: Array<{ id: unknown; patch: Record<string, unknown> }> = [];
  const filters: Record<string, unknown> = {};
  const from = (table: string) => {
    let patch: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST builder stand-in: every method hands itself back.
    const b: any = {
      select: () => b, in: () => b, is: () => b,
      eq: (col: string, v: unknown) => { q[col] = v; filters[`${table}.${col}`] = v; return b; },
      update: (p: Record<string, unknown>) => { patch = p; return b; },
      then: (ok: (v: unknown) => unknown) => {
        if (patch) { writes.push({ id: q.id, patch }); return Promise.resolve({ data: null, error: null }).then(ok); }
        if (table === 'sofa_combo_pricing') {
          return Promise.resolve({ data: combos.map((r) => ({ id: r.id, base_model: r.baseModel, modules: r.modules, tier: r.tier, customer_id: null, prices_by_height: r.pricesByHeight, label: null, effective_from: r.effectiveFrom, created_at: r.createdAt, deleted_at: r.deletedAt })), error: null }).then(ok);
        }
        if (table === 'mfg_sales_order_items') return Promise.resolve({ data: lines, error: null }).then(ok);
        return Promise.resolve({ data: [], error: null }).then(ok);
      },
    };
    return b;
  };
  return { sb: { from }, writes, filters };
}

describe('costChangedSofaSets', () => {
  beforeEach(() => ownCost.clear());
  const line = (id: string, code: string, unit: number, extra: Record<string, unknown> = {}) => ({
    id, item_code: code, item_group: 'sofa', variants: { seatHeight: '28', fabricCode: 'F1' }, qty: 1, total_sen: 100000,
    unit_cost_sen: unit, line_cost_sen: unit, cost_day: null, ...extra,
  });

  it('re-costs the set on the change day, stamps it, and reads only its own company', async () => {
    ownCost.set(`M100-1A(LHF)@${ORDER}`, 50000);
    ownCost.set(`M100-2A(RHF)@${ORDER}`, 70000);
    const { sb, writes, filters } = stub([line('a', 'M100-1A(LHF)', 41666), line('b', 'M100-2A(RHF)', 58334), line('c', 'M100-L(LHF)', 80000)], [TWO, THREE]);
    const res = await costChangedSofaSets(sb, { docNo: 'HC-SO-T1', companyId: 2, orderDay: ORDER, changeDay: CHANGE, models: ['M100'], changedLineIds: ['c'] });
    expect(res).toEqual({ ok: true, written: 3 });
    expect(writes.reduce((s, w) => s + Number(w.patch.line_cost_sen), 0)).toBe(150000);
    expect(writes.every((w) => w.patch.set_cost_day === CHANGE)).toBe(true);
    expect(writes.find((w) => w.id === 'c')!.patch.cost_day).toBe(CHANGE);
    expect(writes.find((w) => w.id === 'a')!.patch.cost_day).toBeUndefined();
    expect(filters['sofa_combo_pricing.company_id']).toBe(2);
    expect(filters['mfg_sales_order_items.company_id']).toBe(2);
  });

  it('a model with no set price ever writes nothing', async () => {
    const { sb, writes } = stub([line('a', 'K200-1A(LHF)', 50000)], [TWO]);
    expect(await costChangedSofaSets(sb, { docNo: 'HC-SO-T2', companyId: 1, orderDay: ORDER, changeDay: CHANGE, models: ['K200'], changedLineIds: [] })).toEqual({ ok: true, written: 0 });
    expect(writes).toEqual([]);
  });
});
