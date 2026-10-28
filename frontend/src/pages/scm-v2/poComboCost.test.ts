/* A from-scratch PO prices a sofa SET at the supplier's combo cost, the same as
   a PO converted from a sales order (2990-0013). The combo in force is the one
   whose effective date is on or before the PO date. */

import { describe, expect, test } from 'vitest';
import { applySupplierCombos, type ComboLine } from './poComboCost';
import type { SofaComboRow } from '../../vendor/shared/sofa-combo-pricing';

const combo = (over: Partial<SofaComboRow>): SofaComboRow => ({
  id: 'c1', baseModel: 'Booqit', modules: [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']],
  tier: null, customerId: null, pricesByHeight: { '10': 220_000 },
  effectiveFrom: '2026-01-01', createdAt: '2026-01-01T00:00:00Z', deletedAt: null, ...over,
});
const line = (rid: string, itemCode: string, unit: number, over: Partial<ComboLine> = {}): ComboLine => ({
  rid, itemCode, category: 'sofa', qty: 1, unitPriceSen: unit, priceTouched: false,
  tier: 'PRICE_2', variants: { seatHeight: '10' }, ...over,
});

describe('applySupplierCombos', () => {
  const lines = [line('a', 'BOOQIT-2A(LHF)', 150_000), line('b', 'BOOQIT-L(LHF)', 100_000)];

  test('a matching set is re-spread so the set costs exactly the combo price', () => {
    const out = applySupplierCombos(lines, [combo({})], '2026-10-24');
    expect((out.get('a') ?? 0) + (out.get('b') ?? 0)).toBe(220_000);
  });

  test('a combo not yet effective on the PO date is ignored; the older one wins', () => {
    const newer = combo({ id: 'c2', effectiveFrom: '2026-11-01', pricesByHeight: { '10': 100_000 } });
    expect(applySupplierCombos(lines, [newer], '2026-10-24').size).toBe(0);
    const out = applySupplierCombos(lines, [newer, combo({})], '2026-10-24');
    expect((out.get('a') ?? 0) + (out.get('b') ?? 0)).toBe(220_000);
  });

  test('the newest effective combo on or before the PO date wins', () => {
    const newer = combo({ id: 'c2', effectiveFrom: '2026-10-01', pricesByHeight: { '10': 200_000 } });
    const out = applySupplierCombos(lines, [combo({}), newer], '2026-10-24');
    expect((out.get('a') ?? 0) + (out.get('b') ?? 0)).toBe(200_000);
  });

  test('a hand-typed price, mixed quantities, or no match leave the line alone', () => {
    expect(applySupplierCombos([{ ...lines[0]!, priceTouched: true }, lines[1]!], [combo({})], '2026-10-24').size).toBe(0);
    expect(applySupplierCombos([{ ...lines[0]!, qty: 2 }, lines[1]!], [combo({})], '2026-10-24').size).toBe(0);
    expect(applySupplierCombos([lines[0]!], [combo({})], '2026-10-24').size).toBe(0);
  });

  test('a combo of another model never applies', () => {
    expect(applySupplierCombos(lines, [combo({ baseModel: 'Other' })], '2026-10-24').size).toBe(0);
  });
});
