import { describe, it, expect } from 'vitest';
import { computeSofaSellingSen, type Cell, type SofaModulePriceSen } from './sofa-build';
import type { SofaComboRow } from './sofa-combo-pricing';

/*
 * The sofa selling engine, in SEN.
 *
 * CHARACTERISATION FIRST. Before this file existed the pricing engine had no
 * test at all — `sofa-combo-pricing.test.ts` covers combo NORMALISATION, not
 * arithmetic. So every number below was pinned against the engine as it stood,
 * and the whole-ringgit cases are the ones that matter most: 140 of the 163
 * sales-side combos in production are whole-ringgit, and they must price to the
 * same sen after this change or live pricing moved.
 *
 * The bug (ledger B4, answered by Actions -> "Sofa price rounding check" on
 * 2026-08-14): the engine's internal unit was whole MYR. Inputs arrive in sen,
 * were divided by 100 and ROUNDED into the pricing object, then multiplied back
 * by 100 on the way out. That round trip is pure loss, and the production check
 * found 23 of 163 combos carrying part-ringgit prices — e.g. RM3152.63 billed
 * as RM3153.00, and RM5712.11 billed as RM5712.00.
 *
 * The engine now carries sen end to end. Its arithmetic is addition and
 * subtraction only, so integer sen is strictly better than fractional MYR:
 * no rounding, and no float either.
 */

/* Depth 24 is the base: widthOffsetPerCushion is (24-24)*2.5 = 0, so a module's
   footprint is its catalogue width and the x offsets below are exact. */
const DEPTH = '24';
const W_2A = 158;  // 2A(LHF) / 2A(RHF)
const W_1A = 95;   // 1A(LHF) / 1A(RHF)

/* Cells must ABUT to land in one group — groupSofas unions by touching bbox,
   and a 2-slot combo cannot match a 1-cell group. The first draft of this file
   spaced them 100cm apart and every combo case silently priced à la carte
   instead, which is a fixture that tests nothing. */
const cell = (id: string, moduleId: string, x: number): Cell => ({
  id, moduleId, x, y: 0, rot: 0,
});

/** A combo priced at `centi` for our depth, matching the given slots.
 *  `effectiveFrom` is in the past because pickComboMatch drops any row whose
 *  effectiveFrom is after today — a fixture dated in the future matches
 *  nothing and would price silently à la carte. */
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
  // The real row the production check surfaced: model 5527, 3S+1A+1A, RM3152.63.
  // Before the fix this billed RM3153.00 — 37 sen more than the combo says.
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

  // R819 2R+3R, RM5712.11 — rounded DOWN before the fix, so the customer was
  // undercharged 11 sen while margin was computed against the rounded figure.
  it('bills RM5712.11 as 571211 sen, not 571200', () => {
    const cells = [cell('a', '2A(LHF)', 0), cell('b', '1A(RHF)', W_2A)];
    const prices: SofaModulePriceSen = { '2A(LHF)': 250000, '1A(RHF)': 330000 };
    const combos = [combo('cR819', [['2A(LHF)'], ['1A(RHF)']], 571211)];
    expect(computeSofaSellingSen(cells, DEPTH, prices, combos)).toBe(571211);
  });

  it('à la carte carries sen too — a part-ringgit MODULE price survives', () => {
    // Section 1 of the production check found ZERO of these today, which is
    // exactly why it must be asserted: the hole is latent, and the next
    // operator to type RM999.50 into a module is the one who finds it.
    const cells = [cell('a', '2A(LHF)', 0), cell('b', '1A(RHF)', W_2A)];
    const prices: SofaModulePriceSen = { '2A(LHF)': 129950, '1A(RHF)': 99950 };
    expect(computeSofaSellingSen(cells, DEPTH, prices, [])).toBe(229900);
  });
});
