import { describe, expect, it } from 'vitest';
import { collapseSofaLines, decodesTo } from './autocount-sofa-collapse';

/* THE ERP LISTS PIECES IN THE ORDER THEY WERE TYPED; THE BOOK READS AN ARMED END
 * AS AN END (docs/bugs/0906). Rows below are the three documents the write-back
 * refused on 2026-09-14 with "composed Desc2 does not survive a decode", read
 * from production the same day (identity fields, Desc2 and variants only). */
const piece = (over: Record<string, unknown>): Record<string, unknown> => ({
  item_group: 'sofa', description: null, qty: 1, unit_price_sen: 0, location: null, delivery_date: null, ...over,
});

/* HC-SO-012736, sofa 8030: typed [Console, 2A(LHF), 1A(RHF)]. */
const so012736 = () => {
  const variants = { colourLabel: 'BO315-23 BEIGE', specials: [] };
  const d2 = '2R+Console+1R/col : B0315-23';
  return [
    piece({ id: 'c', item_code: '8030-Console', linked_ac_dtlkey: 868226, description2: d2, variants }),
    piece({ id: 'l', item_code: '8030-2A(LHF)', linked_ac_dtlkey: 868226, description2: d2, variants }),
    piece({ id: 'r', item_code: '8030-1A(RHF)', linked_ac_dtlkey: 868226, description2: d2, variants }),
  ];
};

/* HC-GRN-2609-006, three sofas interleaved on one receipt; sofa 9058 under key
   928483 was typed [1NA, 1A(LHF), CNR, 1A(RHF)]. */
const grn006 = () => {
  const a = { colourLabel: 'CH141-2 [superseded by CH141-02 on 2026-08-11]', specials: [] };
  const b = { colourLabel: 'CH141-12 METAL', specials: ['Nylon Fabric'] };
  const c = { seatHeight: '32', colourLabel: 'HR805-90', specials: ['Nylon Fabric'] };
  const bD2 = 'CH141-12 METAL / SPECIAL: Nylon Fabric';
  const cD2 = 'HR805-90 / SEAT 32 / SPECIAL: Bottom upgrade to umbrella fabric + Nylon Fabric';
  return [
    piece({ id: '1', item_code: '9058-1NA', linked_ac_dtlkey: 928481, description2: 'CH141-02', variants: a }),
    piece({ id: '2', item_code: '9058-1NA', linked_ac_dtlkey: 928483, description2: bD2, variants: b }),
    piece({ id: '3', item_code: '9050-CNR', linked_ac_dtlkey: 928485, description2: cD2, variants: c }),
    piece({ id: '4', item_code: '9050-1A(RHF)', linked_ac_dtlkey: 928485, description2: cD2, variants: c }),
    piece({ id: '5', item_code: '9058-1NA', linked_ac_dtlkey: 928481, description2: 'CH141-02', variants: a }),
    piece({ id: '6', item_code: '9058-L(LHF)', linked_ac_dtlkey: 928481, description2: 'CH141-02', variants: a }),
    piece({ id: '7', item_code: '9050-1NA', linked_ac_dtlkey: 928485, description2: cD2, variants: c }),
    piece({ id: '8', item_code: '9058-1A(LHF)', linked_ac_dtlkey: 928483, description2: 'CH141-12 METAL / SPECIAL: wrap bottom to Nilon + Nylon Fabric', variants: b }),
    piece({ id: '9', item_code: '9050-1A(LHF)', linked_ac_dtlkey: 928485, description2: cD2, variants: c }),
    piece({ id: '10', item_code: '9058-CNR', linked_ac_dtlkey: 928483, description2: bD2, variants: b }),
    piece({ id: '11', item_code: '9058-L(RHF)', linked_ac_dtlkey: 928481, description2: 'CH141-02', variants: a }),
    piece({ id: '12', item_code: '9058-1A(RHF)', linked_ac_dtlkey: 928483, description2: bD2, variants: b }),
  ];
};

describe('a sofa whose armed ends were typed out of place', () => {
  it('HC-SO-012736: folds into one line whose text the book reads as [2A(LHF), Console, 1A(RHF)]', () => {
    const { lines, refusals } = collapseSofaLines(so012736() as never);
    expect(refusals).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0].linked_ac_dtlkey).toBe('868226');
    expect(decodesTo(String(lines[0].description2), '8030', ['2A(LHF)', 'Console', '1A(RHF)'], null).ok).toBe(true);
  });

  it('HC-GRN-2609-006: all three interleaved sofas fold, none refused', () => {
    const { lines, refusals } = collapseSofaLines(grn006() as never);
    expect(refusals).toEqual([]);
    expect(lines.map((l) => String(l.linked_ac_dtlkey)).sort()).toEqual(['928481', '928483', '928485']);
    const b = lines.find((l) => String(l.linked_ac_dtlkey) === '928483');
    expect(decodesTo(String(b?.description2), '9058', ['1A(LHF)', '1NA', 'CNR', '1A(RHF)'], null).ok).toBe(true);
  });

  it('CONTROL: handedness is never swapped - a right end typed first still reads as the right end', () => {
    const rows = so012736();
    rows[1].item_code = '8030-2A(RHF)';
    rows[2].item_code = '8030-1A(LHF)';
    const { lines, refusals } = collapseSofaLines(rows as never);
    for (const l of lines) {
      expect(decodesTo(String(l.description2), '8030', ['2A(LHF)', 'Console', '1A(RHF)'], null).ok).toBe(false);
    }
    expect(lines.length + refusals.length).toBeGreaterThan(0);
  });

  it('CONTROL: two sofas worth of ends are not reordered - the exact comparison stands', () => {
    const text = '2EL + 1ER + 2EL + 1ER (28")';
    expect(decodesTo(text, '9028', ['2A(LHF)', '2A(LHF)', '1A(RHF)', '1A(RHF)'], null).ok).toBe(false);
  });
});
