import { describe, expect, it } from 'vitest';
import { read, utils } from 'xlsx';
import { buildStyledXlsx } from '../../lib/styled-xlsx';
import type { SofaComboRule } from '../../lib/sofa-combos-queries';
import { comboBook, familyMatches, fitSlots, listedModels, offeredSizes, historyLines, itemsFromEdits, moduleFamilies, presetPieces, presetSlots, type ComboLine } from './comboBook';
import { comboSheets, planComboImport, type ComboGrids } from './comboExcel';

const rule = (over: Partial<SofaComboRule>): SofaComboRule => ({
  id: 'r1', baseModel: 'BANGGAU', modules: [['2A(LHF)', '2A(RHF)'], ['L(LHF)', 'L(RHF)']], tier: 'PRICE_2', customerId: null,
  supplierId: null, pricesByHeight: { '24': 185000, '28': 195000 }, label: '2L', effectiveFrom: '2026-10-21', deletedAt: null,
  notes: '', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z', createdBy: null, ...over,
});

const OWN = ['1A(LHF)', '1A(RHF)', '2A(LHF)', '2A(RHF)', 'CNR', 'L(LHF)', 'L(RHF)'];
const lines = (rules: SofaComboRule[]): ComboLine[] => [...comboBook(rules).values()].flat();

function roundTrip(sheetLines: ComboLine[], supplier: string | null): ComboGrids {
  const wb = read(buildStyledXlsx(comboSheets(sheetLines, supplier, () => ['24', '28'])), { type: 'array' });
  const grids: ComboGrids = {};
  for (const name of wb.SheetNames) {
    grids[name] = utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: false, defval: '' }).map((r) => r.map((v) => String(v).trim()));
  }
  return grids;
}

const ctx = (ls: ComboLine[]) => ({ lines: ls, modulesByModel: { BANGGAU: OWN }, sizes: ['24', '28'], supplierId: null, supplierName: null, today: '2026-11-06' });

describe('a combo is one model and module set across the Prices', () => {
  it('folds the rows of each Price into one line, newest row winning', () => {
    const list = lines([
      rule({ id: 'p2-old', tier: 'PRICE_2', pricesByHeight: { '24': 1 }, effectiveFrom: '2026-01-01' }),
      rule({ id: 'p2', tier: 'PRICE_2' }),
      rule({ id: 'p3', tier: 'PRICE_3', pricesByHeight: { '24': 200000 } }),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]?.byTier.PRICE_2?.id).toBe('p2');
    expect(list[0]?.byTier.PRICE_3?.id).toBe('p3');
  });

  it('numbers a name that repeats, because the file finds a combo by its name', () => {
    const list = lines([rule({ id: 'a' }), rule({ id: 'b', modules: [['CNR']] })]);
    expect(list.map((l) => l.name)).toEqual(['2L', '2L (2)']);
  });
});

describe('copying a combo to another model', () => {
  it('keeps only the modules this model makes', () => {
    expect(fitSlots([['2A(LHF)', '2A(X)'], ['CNR']], OWN)).toEqual({ modules: [['2A(LHF)'], ['CNR']], missing: [] });
  });
  it('names the piece it cannot make', () => {
    expect(fitSlots([['3S'], ['CNR']], OWN).missing).toEqual(['3S']);
  });
  it('reads a preset piece with no side as both sides', () => {
    expect(presetSlots([['2A'], ['CNR']], OWN)).toEqual([['2A(LHF)', '2A(RHF)'], ['CNR']]);
  });
  it('keeps a preset piece with a side as that side only', () => {
    expect(presetSlots([['2A(RHF)'], ['CNR']], OWN)).toEqual([['2A(RHF)'], ['CNR']]);
  });
  it('a preset piece the model does not make is named missing', () => {
    expect(fitSlots(presetSlots([['2A'], ['3S']], OWN), OWN).missing).toEqual(['3S']);
  });
  it('writes a preset on one line', () => {
    expect(presetPieces([['2A'], ['CNR'], ['1A', '1B']])).toBe('2A + CNR + 1A or 1B');
  });
});

describe('the sizes of a model', () => {
  it('follows the master when the model has no list of its own', () => {
    expect(offeredSizes(undefined, ['24', '30', '26'], [])).toEqual(['24', '26', '30']);
    expect(offeredSizes([], ['24'], [])).toEqual(['24']);
  });
  it('uses the model list when it has one', () => {
    expect(offeredSizes(['28'], ['24', '28', '30'], [])).toEqual(['28']);
  });
  it('never hides a size that already has a price', () => {
    expect(offeredSizes(['28'], ['24'], ['35'])).toEqual(['28', '35']);
  });
});

describe('the model list', () => {
  const all = [
    { code: '5030', name: 'Cloud', supplierCode: null, combos: 2 },
    { code: '5527', name: 'Booqit', supplierCode: '8030', combos: 0 },
    { code: '9081', name: 'Nova', supplierCode: null, combos: 0 },
  ];
  it('shows only models with combos by default', () => {
    expect(listedModels(all, '', false, null).map((m) => m.code)).toEqual(['5030']);
  });
  it('shows every model when asked', () => {
    expect(listedModels(all, '', true, null)).toHaveLength(3);
  });
  it('keeps the open model listed', () => {
    expect(listedModels(all, '', false, '9081').map((m) => m.code)).toEqual(['5030', '9081']);
  });
  it('a search finds a model with no combos, by our code, our name or the supplier code', () => {
    expect(listedModels(all, 'booq', false, null).map((m) => m.code)).toEqual(['5527']);
    expect(listedModels(all, '8030', false, null).map((m) => m.code)).toEqual(['5527']);
  });
});

describe('the module picker', () => {
  it('finds a piece by name as well as by code', () => {
    const family = moduleFamilies(['1NA'])[0]!;
    expect(familyMatches(family, 'no arms', { '1NA': '1NA · No arms' })).toBe(true);
    expect(familyMatches(family, '1na', {})).toBe(true);
    expect(familyMatches(family, 'corner', { '1NA': '1NA · No arms' })).toBe(false);
  });
  it('puts LHF and RHF of a piece on one row', () => {
    const families = moduleFamilies(OWN);
    expect(families.find((f) => f.code === '2A')?.variants.map((v) => v.label)).toEqual(['LHF', 'RHF']);
    expect(families.find((f) => f.code === 'CNR')?.group).toBe('Corner');
  });
});

describe('saving typed cells', () => {
  const line = lines([rule({})])[0]!;
  const map = new Map([[line.key, line]]);
  const key = (h: string, tier = 'PRICE_2') => JSON.stringify([line.key, tier, h]);

  it('writes only what changed', () => {
    const { items } = itemsFromEdits({ [key('24')]: '1,900.00', [key('28')]: '1,950.00' }, map, null, '2026-11-07');
    expect(items).toHaveLength(1);
    expect(items[0]?.prices).toEqual({ '24': 190000 });
  });
  it('an emptied cell takes the price away', () => {
    expect(itemsFromEdits({ [key('24')]: '' }, map, null, '2026-11-07').items[0]?.prices).toEqual({ '24': null });
  });
  it('refuses what is not a price', () => {
    expect(itemsFromEdits({ [key('24')]: 'abc' }, map, null, '2026-11-07').bad).toBe('abc');
  });
});

describe('edit history', () => {
  it('gives one line per size that moved', () => {
    const out = historyLines([
      rule({ id: 'a', pricesByHeight: { '24': 100000 }, effectiveFrom: '2026-01-01' }),
      rule({ id: 'b', pricesByHeight: { '24': 110000, '28': 120000 }, effectiveFrom: '2026-02-01', createdByName: 'Lim' }),
    ]);
    expect(out.map((l) => l.what)).toEqual(['28" seat', '24" seat', 'Created']);
    expect(out[0]?.who).toBe('Lim');
    expect(out[1]?.detail).toContain('to');
  });
});

describe('the Excel file', () => {
  const book = lines([rule({}), rule({ id: 'empty', label: '2A + CNR', modules: [['2A(LHF)'], ['CNR']], pricesByHeight: {}, tier: 'PRICE_1' })]);

  it('has a sheet for each Price and one for the modules', () => {
    expect(Object.keys(roundTrip(book, null))).toEqual(['Price 1', 'Price 2', 'Price 3', 'Price 4', 'Modules']);
  });

  it('an untouched file changes nothing', () => {
    const plan = planComboImport(roundTrip(book, null), ctx(book));
    expect(plan.changes).toEqual([]);
    expect(plan.refused).toEqual([]);
    expect(plan.apply).toEqual([]);
  });

  const edit = (grids: ComboGrids, sheet: string, combo: string, column: string, value: string): ComboGrids => {
    const rows = grids[sheet]!.map((r) => [...r]);
    const c = rows[0]!.indexOf(column);
    const comboCol = rows[0]!.indexOf('Combo');
    for (const r of rows) if (r[comboCol] === combo) r[c] = value;
    return { ...grids, [sheet]: rows };
  };

  it('fills a first price', () => {
    const plan = planComboImport(edit(roundTrip(book, null), 'Price 2', '2A + CNR', '28', '3,100.00'), ctx(book));
    expect(plan.changes.map((c) => c.kind)).toEqual(['First price']);
    expect(plan.apply[0]).toMatchObject({ tier: 'PRICE_2', prices: { '28': 310000 }, effectiveFrom: '2026-11-06' });
  });

  it('a changed price with the exported date starts today, not on the old date', () => {
    const plan = planComboImport(edit(roundTrip(book, null), 'Price 2', '2L', '24', '1,900.00'), ctx(book));
    expect(plan.apply[0]?.effectiveFrom).toBe('2026-11-06');
  });

  it('a blank cell keeps the price', () => {
    const plan = planComboImport(edit(roundTrip(book, null), 'Price 2', '2L', '24', ''), ctx(book));
    expect(plan.changes).toEqual([]);
  });

  it('X takes a price away', () => {
    const plan = planComboImport(edit(roundTrip(book, null), 'Price 2', '2L', '24', 'x'), ctx(book));
    expect(plan.apply[0]?.prices).toEqual({ '24': null });
  });

  it('refuses a module the model does not make, and names it', () => {
    const plan = planComboImport(edit(roundTrip(book, null), 'Modules', '2L', 'Slot 1', '1A(MID)'), ctx(book));
    expect(plan.refused[0]).toContain('1A(MID) is not a module of BANGGAU');
  });

  it('changing modules moves the combo, and a price on the same row lands on the new modules', () => {
    let grids = edit(roundTrip(book, null), 'Modules', '2L', 'Slot 2', 'CNR');
    grids = edit(grids, 'Price 2', '2L', '24', '1,900.00');
    const plan = planComboImport(grids, ctx(book));
    expect(plan.recompose).toHaveLength(1);
    expect(plan.apply[0]?.modules).toEqual([['2A(LHF)', '2A(RHF)'], ['CNR']]);
  });

  it('Delete on the Modules sheet drops that combo from the Price sheets too', () => {
    let grids = edit(roundTrip(book, null), 'Modules', '2L', 'Delete', 'Yes');
    grids = edit(grids, 'Price 2', '2L', '24', '1,900.00');
    const plan = planComboImport(grids, ctx(book));
    expect(plan.retire).toHaveLength(1);
    expect(plan.apply).toEqual([]);
  });

  it("refuses another supplier's row", () => {
    const grids = edit(roundTrip(book, 'Dorsettloft'), 'Price 2', '2L', '24', '1,900.00');
    const plan = planComboImport(edit(grids, 'Price 2', '2L', 'Supplier', 'Armani'), { ...ctx(book), supplierName: 'Dorsettloft', supplierId: 's1' });
    expect(plan.refused[0]).toContain('Armani');
    expect(plan.apply).toEqual([]);
  });

  it("refuses a Products file on a supplier's page, or it would write master costs as theirs", () => {
    const grids = edit(roundTrip(book, null), 'Price 2', '2L', '24', '1,900.00');
    const plan = planComboImport(grids, { ...ctx(book), supplierName: 'Dorsettloft', supplierId: 's1' });
    expect(plan.refused[0]).toContain('Products page');
    expect(plan.apply).toEqual([]);
  });

  it('refuses a supplier file on Products, even a Delete on its Modules sheet', () => {
    const grids = edit(roundTrip(book, 'Dorsettloft'), 'Modules', '2L', 'Delete', 'Yes');
    const plan = planComboImport(grids, ctx(book));
    expect(plan.refused[0]).toContain('Dorsettloft');
    expect(plan.retire).toEqual([]);
  });

  it('a retyped combo name is a rename, and its prices are not first prices', () => {
    let grids = edit(roundTrip(book, null), 'Modules', '2L', 'Combo', 'Two seat L');
    grids = edit(grids, 'Price 2', '2L', 'Combo', 'Two seat L');
    const plan = planComboImport(grids, ctx(book));
    expect(plan.changes.map((c) => c.kind)).toEqual(['Rename']);
    expect(plan.apply[0]).toMatchObject({ label: 'Two seat L', prices: {} });
  });

  it('refuses a column that is not a size', () => {
    const grids = roundTrip(book, null);
    grids['Price 2']![0]![5] = '99';
    expect(planComboImport(grids, ctx(book)).refused[0]).toContain('column 99');
  });

  it('a slot that has more than four modules columns still round-trips', () => {
    const wide = lines([rule({ modules: [['1A(LHF)'], ['1A(RHF)'], ['2A(LHF)'], ['2A(RHF)'], ['CNR'], ['L(LHF)']] })]);
    expect(roundTrip(wide, null).Modules?.[0]).toContain('Slot 6');
    expect(planComboImport(roundTrip(wide, null), ctx(wide)).changes).toEqual([]);
  });
});
