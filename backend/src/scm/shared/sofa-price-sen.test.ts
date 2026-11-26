import { describe, it, expect } from 'vitest';
import { computeSofaSellingSen, type Cell, type SofaModulePriceSen } from './sofa-build';
import type { SofaComboRow } from './sofa-combo-pricing';


const DEPTH = '24';
const W_2A = 158;
const W_1A = 95;

const cell = (id: string, moduleId: string, x: number): Cell => ({
  id, moduleId, x, y: 0, rot: 0,
});

const combo = (id: string, slots: string[][], centi: number): SofaComboRow => ({
  id,
  baseModel: '',
  modules: slots,
  tier: 'PRICE_1',
  customerId: null,
  effectiveFrom: '2020-01-01',
  pricesByHeight: { [DEPTH]: centi },
});

describe('computeSofaSellingSen — whole ringgit is unchanged', () => {
  it('à la carte: two modules at exact ringgit sum to their exact sen', () => {
    const cells = [cell('a', '2A(LHF)', 0), cell('b', '1A(RHF)', W_2A)];
    const prices: SofaModulePriceSen = { '2A(LHF)': 130000, '1A(RHF)': 90000 };
    expect(computeSofaSellingSen(cells, DEPTH, prices, [])).toBe(220000);
  });

  it('a whole-ringgit combo bills its exact price — the 140 clean rows', () => {
    const cells = [cell('a', '2A(LHF)', 0), cell('b', '1A(RHF)', W_2A)];
    const prices: SofaModulePriceSen = { '2A(LHF)': 130000, '1A(RHF)': 90000 };
    const combos = [combo('c1', [['2A(LHF)'], ['1A(RHF)']], 500000)];
    expect(computeSofaSellingSen(cells, DEPTH, prices, combos)).toBe(500000);
  });

  it('no price for a module is zero, not a throw', () => {
    const cells = [cell('a', 'UNPRICED', 0)];
    expect(computeSofaSellingSen(cells, DEPTH, {}, [])).toBe(0);
  });
});

describe('computeSofaSellingSen — part-ringgit is no longer rounded away', () => {
  it('bills RM3152.63 as 315263 sen, not 315300', () => {
    const cells = [
      cell('a', '2A(LHF)', 0),
      cell('b', '1A(RHF)', W_2A),
      cell('c', '1A(LHF)', W_2A + W_1A),
    ];
    const prices: SofaModulePriceSen = { '2A(LHF)': 200000, '1A(RHF)': 90000, '1A(LHF)': 90000 };
    const combos = [combo('c5527', [['2A(LHF)'], ['1A(RHF)'], ['1A(LHF)']], 315263)];
    expect(computeSofaSellingSen(cells, DEPTH, prices, combos)).toBe(315263);
  });

  it('bills RM5712.11 as 571211 sen, not 571200', () => {
    const cells = [cell('a', '2A(LHF)', 0), cell('b', '1A(RHF)', W_2A)];
    const prices: SofaModulePriceSen = { '2A(LHF)': 250000, '1A(RHF)': 330000 };
    const combos = [combo('cR819', [['2A(LHF)'], ['1A(RHF)']], 571211)];
    expect(computeSofaSellingSen(cells, DEPTH, prices, combos)).toBe(571211);
  });

  it('à la carte carries sen too — a part-ringgit MODULE price survives', () => {
    const cells = [cell('a', '2A(LHF)', 0), cell('b', '1A(RHF)', W_2A)];
    const prices: SofaModulePriceSen = { '2A(LHF)': 129950, '1A(RHF)': 99950 };
    expect(computeSofaSellingSen(cells, DEPTH, prices, [])).toBe(229900);
  });
});
