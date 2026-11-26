import { describe, expect, it } from 'vitest';
import { collapseSofaLines } from './autocount-sofa-collapse';

const v = (note: string) => ({
  colourId: 'HR805-20', fabricId: 'HR805', legHeight: 'Default', fabricCode: 'HR805-20',
  seatHeight: '32', colourLabel: 'HR805-20', fabricLabel: 'HR805', extraAddonNote: note,
});
const piece = (over: Record<string, unknown>): Record<string, unknown> => ({
  item_group: 'sofa', description: 'SOFA 8069', qty: 1, unit_price_sen: 0,
  location: null, delivery_date: null, ...over,
});
const hcSo013320 = () => [
  piece({ id: 'a9e6', item_code: '8069-1A(LHF)', linked_ac_dtlkey: 910573, variants: v('Extra 12" storage box'),
    description2: 'HR805-20 / SEAT 32 / LEG DEFAULT / SPECIAL: Extra 12" storage box' }),
  piece({ id: '6048', item_code: '8069-1B(RHF)', linked_ac_dtlkey: 910573, variants: v('Extra 12" Armrest'),
    description2: 'HR805-20 / SEAT 32 / LEG DEFAULT / SPECIAL: Extra 12" Armrest' }),
];

describe('adjacent pieces of ONE book line whose Desc2 differs', () => {
  it('fold into one line carrying the book key, instead of being refused one piece at a time', () => {
    const { lines, refusals } = collapseSofaLines(hcSo013320() as never);
    expect(refusals).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0].linked_ac_dtlkey).toBe('910573');
    expect(lines[0].sourceIndexes).toEqual([0, 1]);
    expect(lines[0].item_code).toBe('8069-1S');
  });

  it('CONTROL — adjacent pieces with DIFFERENT keys are separate book lines and are never gathered into one', () => {
    const rows = hcSo013320();
    rows[1].linked_ac_dtlkey = 910574;
    const { lines, refusals } = collapseSofaLines(rows as never);
    const groups = [...lines.map((l) => l.sourceIndexes), ...refusals.map((r) => r.sourceIndexes)];
    expect(groups).not.toContainEqual([0, 1]);
  });

  it('CONTROL — adjacent pieces with the same key AND the same text still fold through the adjacency rule', () => {
    const rows = hcSo013320();
    rows[1].description2 = rows[0].description2;
    rows[1].variants = rows[0].variants;
    const { lines, refusals } = collapseSofaLines(rows as never);
    expect(refusals).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0].sourceIndexes).toEqual([0, 1]);
  });
});
