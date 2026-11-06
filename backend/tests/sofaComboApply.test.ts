import { describe, expect, it } from 'vitest';
import { clearHeights, hasAnyPrice, mergeComboPrices, newestComboRow } from '../src/scm/lib/sofa-combo-apply';
import { pickComboMatch, type SofaComboRow } from '../src/scm/shared/sofa-combo-pricing';

const combo = (over: Partial<SofaComboRow>): SofaComboRow => ({
  id: 'a', baseModel: 'BANGGAU', modules: [['2A']], tier: 'PRICE_1', customerId: null,
  pricesByHeight: { '24': 100000 }, effectiveFrom: '2026-01-01', ...over,
});
const args = { baseModel: 'BANGGAU', modules: ['2A'], customerId: null, tier: 'PRICE_1' as const, height: '24', asOf: '2026-11-06' };

describe('a batch combo write', () => {
  it('keeps every size it does not name, so a blank Excel cell clears nothing', () => {
    const out = mergeComboPrices({ '24': 100, '28': 200 }, { '24': 150 });
    expect(out).toEqual({ prices: { '24': 150, '28': 200 }, changed: true, removed: [] });
  });

  it('counts the same price as no change, so a re-import adds no row', () => {
    expect(mergeComboPrices({ '24': 100 }, { '24': 100 }).changed).toBe(false);
  });

  it('reports a size that loses its price', () => {
    expect(mergeComboPrices({ '24': 100 }, { '24': null }).removed).toEqual(['24']);
  });

  it('does not count emptying an empty size as a removal', () => {
    expect(mergeComboPrices({}, { '24': null })).toEqual({ prices: {}, changed: false, removed: [] });
  });

  it('clears the selling grid with the cost, or the old selling price is still charged', () => {
    expect(clearHeights({ '24': 500, '28': 600 }, ['24'])).toEqual({ '24': null, '28': 600 });
  });

  it('takes the newest row by date, then by creation', () => {
    const rows = [
      { id: 'old', effective_from: '2026-01-01', created_at: '2026-01-01T00:00:00Z' },
      { id: 'first', effective_from: '2026-02-01', created_at: '2026-02-01T00:00:00Z' },
      { id: 'second', effective_from: '2026-02-01', created_at: '2026-02-02T00:00:00Z' },
    ];
    expect(newestComboRow(rows)?.id).toBe('second');
  });

  it('knows an empty grid has no price', () => {
    expect(hasAnyPrice({ '24': null })).toBe(false);
    expect(hasAnyPrice(undefined)).toBe(false);
    expect(hasAnyPrice({ '24': 1 })).toBe(true);
  });
});

describe('a combo with no price yet', () => {
  it('prices nothing', () => {
    expect(pickComboMatch(args, [combo({ pricesByHeight: {} })])).toBeNull();
  });

  it('does not hide a priced combo it sits beside', () => {
    const match = pickComboMatch(args, [combo({ id: 'priced' }), combo({ id: 'empty', pricesByHeight: {}, modules: [['2A', 'L']], effectiveFrom: '2026-11-01' })]);
    expect(match?.row.id).toBe('priced');
  });

  it('this is why taking a price away must retire the older rows: they still match', () => {
    const newer = combo({ id: 'newer', pricesByHeight: { '24': null }, effectiveFrom: '2026-11-01' });
    expect(pickComboMatch(args, [combo({ id: 'older' }), newer])?.row.id).toBe('older');
    expect(pickComboMatch(args, [newer])).toBeNull();
  });
});
