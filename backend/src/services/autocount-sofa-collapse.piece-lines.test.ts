import { describe, expect, it } from 'vitest';
import { collapseSofaLines } from './autocount-sofa-collapse';

/* A DOCUMENT THAT STORES ITS SOFA PIECES AS SEPARATE BOOK LINES (docs/bugs/0909).
 * Rows below are HC-PO-2609-063 and HC-PO-2609-047 as production held them on
 * 2026-09-14, in AutoCount line order (identity fields and Desc2 only). */
const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  item_group: 'sofa', description: null, qty: 1, unit_price_sen: 0, location: null, delivery_date: null, variants: null, ...over,
});

const po063 = () => [
  row({ id: 'l', item_code: '8030-1A(LHF)', linked_ac_dtlkey: 929346, description2: 'HR805-90 / SEAT 35 / LEG DEFAULT / SPECIAL: Nilonbottom' }),
  row({ id: 'p', item_code: '5543 LONG PILLOW', item_group: 'accessory', qty: 2, linked_ac_dtlkey: 929350, description2: null }),
  row({ id: 'r', item_code: '8030-1A(RHF)', linked_ac_dtlkey: 929348, description2: 'HR805-90 / SEAT 35 / LEG DEFAULT / SPECIAL: Nilonbottom' }),
];

const po047 = () => [
  row({ id: 'c', item_code: '9028-L(LHF)', linked_ac_dtlkey: 928220, description2: 'BO315-22 FEATHER / SEAT 28 / SPECIAL: back rest change 8069 + Nilon bottom + Nylon Fabric' }),
  row({ id: 'e', item_code: '9028-2A(RHF)', linked_ac_dtlkey: 928221, description2: 'BO315-22 FEATHER / SEAT 28 / SPECIAL: 5537 Backrest + Nylon Fabric' }),
];

describe('sofa pieces a document keeps as separate book lines', () => {
  it('HC-PO-2609-063: both armed ends go through as themselves, each under its own key', () => {
    const { lines, refusals } = collapseSofaLines(po063() as never);
    expect(refusals).toEqual([]);
    const sofa = lines.filter((l) => String(l.item_code).startsWith('8030-'));
    expect(sofa.map((l) => [l.item_code, String(l.linked_ac_dtlkey), l.via])).toEqual([
      ['8030-1A(LHF)', '929346', 'passthrough'],
      ['8030-1A(RHF)', '929348', 'passthrough'],
    ]);
  });

  it('HC-PO-2609-047: the right-hand end is no longer refused', () => {
    const { lines, refusals } = collapseSofaLines(po047() as never);
    expect(refusals).toEqual([]);
    expect(lines.map((l) => String(l.linked_ac_dtlkey)).sort()).toEqual(['928220', '928221']);
  });

  it('CONTROL: a lone keyed armed end with no other piece of its model still folds, and is refused as before', () => {
    const { refusals } = collapseSofaLines([po063()[0]] as never);
    expect(refusals).toHaveLength(1);
  });

  it('CONTROL: pieces sharing ONE key are still one book line and fold', () => {
    const rows = po063().filter((r) => r.id !== 'p');
    rows[1].linked_ac_dtlkey = 929346;
    const { lines } = collapseSofaLines(rows as never);
    expect(lines.filter((l) => l.via === 'passthrough')).toHaveLength(0);
  });
});
