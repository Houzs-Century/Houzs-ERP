// Owner 2026-11-23: Finance sees, for every product change on an order, whether
// the selling change covered the cost change (「我主要是看销售价和成本的变动，因为
// 我要确定这些改动销售价是足够cover成本的变动」), and the changes whose selling did
// not move but whose cost did, as their own list (「要列出来」). These pin what
// counts, which bucket an event falls in, and that service lines never count.
// Codes copy the shape of real lines; every amount is made up.
import { describe, expect, it } from 'vitest';
import { changeCoverage, changeSnapshot, productChangeEvent, type ChangeLineSnap, type SoLineForChange } from './so-product-change';

const snap = (id: string, code: string, group: string, qty: number, sellingSen: number, costSen: number, spec: Record<string, unknown> = {}): ChangeLineSnap => ({
  id, code, group, qty, sellingSen, costSen, spec,
});

describe('productChangeEvent', () => {
  it('a SKU change that raised the price more than the cost is covered', () => {
    const ev = productChangeEvent(
      [snap('1', 'JAGER-(Q)', 'mattress', 1, 300000, 120000)],
      [snap('1', 'NTYR-(Q)', 'mattress', 1, 350000, 150000)],
    );
    expect(ev.types).toEqual(['sku']);
    expect(ev.bucket).toBe('SELLING');
    expect(changeCoverage(ev)).toMatchObject({ sellingDeltaSen: 50000, costDeltaSen: 30000, marginDeltaSen: 20000, covered: true, shortfallSen: 0 });
  });

  it('a cheaper price that dropped more than the cost is not covered, by the shortfall', () => {
    const ev = productChangeEvent(
      [snap('1', 'JAGER-(K)', 'mattress', 1, 400000, 150000)],
      [snap('1', 'JAGER-(Q)', 'mattress', 1, 300000, 120000)],
    );
    expect(ev.bucket).toBe('SELLING');
    expect(changeCoverage(ev)).toMatchObject({ covered: false, shortfallSen: 70000 });
  });

  it('selling unchanged but cost changed is its own bucket; a cost rise is not covered', () => {
    const ev = productChangeEvent(
      [snap('1', '9028-2A(LHF)', 'sofa', 1, 200000, 100000)],
      [snap('1', '9028-2A(LHF)', 'sofa', 1, 200000, 108000, { seatHeight: '28' })],
    );
    expect(ev.types).toEqual(['height']);
    expect(ev.bucket).toBe('COST_ONLY');
    expect(changeCoverage(ev)).toMatchObject({ covered: false, shortfallSen: 8000 });
  });

  it('a seat height that did not move the cost is not a product change', () => {
    const ev = productChangeEvent(
      [snap('1', '9028-2A(LHF)', 'sofa', 1, 200000, 100000, { seatHeight: '24' })],
      [snap('1', '9028-2A(LHF)', 'sofa', 1, 200000, 100000, { seatHeight: '28' })],
    );
    expect(ev.types).toEqual([]);
    expect(ev.bucket).toBeNull();
  });

  it('a qty change with no selling change is a typo fix and not an event', () => {
    const ev = productChangeEvent(
      [snap('1', 'PILLOW-STD', 'accessory', 2, 20000, 6000)],
      [snap('1', 'PILLOW-STD', 'accessory', 1, 20000, 3000)],
    );
    expect(ev.types).toEqual([]);
    expect(ev.bucket).toBeNull();
  });

  it('a qty change that moved the selling amount counts', () => {
    const ev = productChangeEvent(
      [snap('1', 'PILLOW-STD', 'accessory', 1, 10000, 3000)],
      [snap('1', 'PILLOW-STD', 'accessory', 2, 20000, 6500)],
    );
    expect(ev.types).toEqual(['qty']);
    expect(ev.bucket).toBe('SELLING');
  });

  it('a sofa piece added to a set of the same model is `pieces`; a new model is a new line', () => {
    const before = [snap('1', 'XAMMAR-2A(LHF)', 'sofa', 1, 150000, 90000)];
    expect(productChangeEvent(before, [...before, snap('2', 'XAMMAR-L(RHF)', 'sofa', 1, 0, 95000)]).types).toEqual(['pieces']);
    expect(productChangeEvent(before, [...before, snap('3', 'KABBIN-1A(RHF)', 'sofa', 1, 0, 50000)]).types).toEqual(['new_line']);
    expect(productChangeEvent(before, []).types).toEqual(['removed_line']);
  });

  it('a price change alone is not a product change, but it counts in an event it happens in', () => {
    const before = [snap('1', 'JAGER-(Q)', 'mattress', 1, 300000, 120000), snap('2', 'CODY-(Q)', 'bedframe', 1, 100000, 40000)];
    expect(productChangeEvent(before, [before[0]!, { ...before[1]!, sellingSen: 90000 }]).bucket).toBeNull();
    const ev = productChangeEvent(before, [{ ...before[0]!, code: 'NTYR-(Q)', costSen: 130000 }, { ...before[1]!, sellingSen: 110000 }]);
    expect(ev.types).toEqual(['sku']);
    expect(ev.bucket).toBe('SELLING');
    expect(ev.lines.map((l) => [l.id, l.types])).toEqual([['1', ['sku']], ['2', []]]);
  });

  it('the other side of the same piece is not a SKU change', () => {
    const ev = productChangeEvent(
      [snap('1', 'XAMMAR-2A(LHF)', 'sofa', 1, 150000, 90000)],
      [snap('1', 'XAMMAR-2A(RHF)', 'sofa', 1, 150000, 90000)],
    );
    expect(ev.types).toEqual([]);
  });
});

describe('changeSnapshot', () => {
  const row = (id: string, code: string, group: string, extra: Partial<SoLineForChange> = {}): SoLineForChange => ({
    id, item_code: code, item_group: group, variants: { seatHeight: '24', fabricCode: 'EZ-1', fabricLabel: 'Grey', remark: 'x' },
    qty: 1, total_sen: 10000, line_cost_sen: 5000, cancelled: false, ...extra,
  });
  const category: Record<string, string> = { 'TRANSPORTATION CHARGES': 'SERVICE', MISC: 'SERVICE', 'SOFA SL': 'SERVICE' };

  it('leaves out service lines by group, SVC- code or catalogue category, and cancelled lines', () => {
    const out = changeSnapshot([
      row('1', 'JAGER-(Q)', 'mattress'),
      row('2', 'SVC-DELIVERY', 'others'),
      row('3', 'TRANSPORTATION CHARGES', 'others'),
      row('4', 'MISC', 'others'),
      row('5', 'SOFA SL', 'sofa'),
      row('6', 'DISPOSE', 'service'),
      row('7', 'CODY-(Q)', 'bedframe', { cancelled: true }),
    ], (code) => category[code] ?? null);
    expect(out.map((l) => l.id)).toEqual(['1']);
  });

  it('keeps the spec that can move a cost, not the colour or the remark', () => {
    const [l] = changeSnapshot([row('1', '9028-2A(LHF)', 'sofa', { variants: { depth: '28', fabricCode: 'EZ-1', fabricLabel: 'Grey', remark: 'x', legHeight: '6' } })], () => null);
    expect(l!.spec).toEqual({ seatHeight: '28', legHeight: '6' });
  });
});
