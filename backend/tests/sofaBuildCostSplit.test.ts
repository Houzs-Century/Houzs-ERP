// A POS sofa build's cost is shared over its module lines by each module's own
// cost, not by its selling price. 2990-SO-2611-107 (KABBIN 2A + L, 2026-11-18):
// the L has no selling price, so by selling weight it was sold at RM 0 with no
// cost while the 2A carried the whole build's cost, and the nightly cost fill
// then costed the L again on top. Amounts are illustrative. Sen.
import { describe, expect, it } from 'vitest';
import { splitSofaBuildIntoModuleLines } from '../src/scm/shared/so-sofa-split';

const cells = [{ moduleId: '2A(LHF)' }, { moduleId: 'L(RHF)' }];
const split = (buildUnitCostSen: number, moduleCostsSen: Record<string, number> | null) => {
  const out = splitSofaBuildIntoModuleLines({
    baseModel: 'KABBIN', cells, buildUnitPriceSen: 299000, buildUnitCostSen,
    modulePrices: { '2A(LHF)': 149000 }, moduleCostsSen,
  }) ?? [];
  return Object.fromEntries(out.map((s) => [s.moduleCode, { price: s.unitPriceSen, cost: s.unitCostSen }]));
};

describe('sharing a POS build over its module lines', () => {
  it('gives each module its own cost, even one with no selling price', () => {
    expect(split(200000, { '2A(LHF)': 95000, 'L(RHF)': 105000 })).toEqual({
      '2A(LHF)': { price: 299000, cost: 95000 },
      'L(RHF)': { price: 0, cost: 105000 },
    });
  });

  it('keeps the selling-weight share when the build cost was not summed from module costs', () => {
    expect(split(200000, null)).toEqual({
      '2A(LHF)': { price: 299000, cost: 200000 },
      'L(RHF)': { price: 0, cost: 0 },
    });
    expect(split(200000, { '1NA': 65000 })['2A(LHF)']).toEqual({ price: 299000, cost: 200000 });
  });

  it('leaves a module with no cost at the build height at RM 0: its cost was never in the build cost', () => {
    expect(split(105000, { 'L(RHF)': 105000 })).toEqual({
      '2A(LHF)': { price: 299000, cost: 0 },
      'L(RHF)': { price: 0, cost: 105000 },
    });
  });
});
