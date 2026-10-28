import { describe, expect, it } from 'vitest';
import { collapseSofaLines } from './autocount-sofa-collapse';

/* ONE BOOK LINE, TWO DIFFERENT TEXTS — HC-SO-013320 and HC-PO-010008, 2026-09-14.
 *
 * Both compartments of sofa 8069 carry the SAME AutoCount DtlKey (910573 on the
 * sales order, 910869 on the purchase order): the account book holds the sofa as
 * ONE folded line. HC-SO-013320/A1 re-derived each piece's Desc2 from its own
 * variants, and the two pieces have different special orders, so their texts now
 * differ. The adjacency run breaks on a Desc2 change, and scatteredByBookLine
 * skipped the pair because they are adjacent — so each piece was collapsed ALONE
 * and refused: "cannot spell [1A(LHF)]", "cannot spell [1B(RHF)]" (requeue plan
 * run 34823021667; rows read by probe run 34827560743).
 */
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

  /* Only the GATHERING is pinned here. What a lone keyed piece then does is the
     pre-existing single-compartment rule in flush() ("a single keyed compartment
     is a build the book holds as one line, which must still fold"), unchanged by
     this fix and not what this file is about. */
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
