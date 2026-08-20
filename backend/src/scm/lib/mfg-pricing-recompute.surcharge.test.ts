/* "让收费追上成本" — the SELLING path must charge the surcharge the COST path
 * already books (owner 2026-08-11).
 *
 * THE DEFECT. `specialsSurchargeSen` reached the customer's price only through
 * `breakdown.unitPriceSen`, and only inside the catalog branch, which was gated
 * on `category !== 'SOFA' && effectiveBaseSen > 0`. Two whole populations were
 * therefore exempt:
 *
 *   SOFA            — excluded by category. The sofa branch rebuilt the price
 *                     from Σ module prices and never re-added the surcharges,
 *                     while the COST branch beside it DID re-add its own
 *                     (`costSurchargesSen`).
 *   sell_price_sen 0 — excluded by the `> 0` test, whatever the category.
 *
 * So a priced sofa add-on was costed and never charged: it could only ever
 * reduce margin. These tests pin the symmetry, and — the load-bearing half —
 * pin that it cannot reach a MIGRATED line.
 *
 * Every assertion here is a DELTA (with the add-on minus without), not an
 * absolute figure. The invariant under test is "the surcharge arrives", and a
 * delta states exactly that without re-encoding the rest of the pricing engine
 * into the expectations.
 */
import { describe, it, expect } from 'vitest';
import {
  recomputeFromSnapshot,
  type MfgItemForRecompute,
  type ProductRowLite,
} from './mfg-pricing-recompute';
import type { MaintenanceConfig, SpecialAddonDef } from '../shared/mfg-pricing';

const ADDON_SEN = 5000; // RM 50

/* ONE price, per the owner's 2026-06-22 ruling: the Specials editor writes the
   same number to selling_price_sen and cost_price_sen. Costing the add-on at a
   different figure would make the cost/selling agreement test vacuous. */
const HYDRAULIC: SpecialAddonDef = {
  code: 'Hydraulic',
  sellingPriceSen: ADDON_SEN,
  costPriceSen: ADDON_SEN,
};

/* The pool builder only fires when a config object exists — `effectiveConfig`
   falls back to a null `config` unchanged. A null config here would make every
   surcharge 0 and every test below pass for the wrong reason. */
const EMPTY_CONFIG: MaintenanceConfig = {
  divanHeights: [], legHeights: [], totalHeights: [], gaps: [],
  specials: [], sofaLegHeights: [], sofaSpecials: [], sofaSizes: [],
};

const bedframe = (sellPriceSen: number | null): ProductRowLite => ({
  code: 'BF-1', category: 'BEDFRAME',
  base_price_sen: 30000, price1_sen: null, cost_price_sen: 30000,
  seat_height_prices: null, base_model: null, sell_price_sen: sellPriceSen,
});

const sofa: ProductRowLite = {
  code: 'SF-1', category: 'SOFA',
  base_price_sen: 100000, price1_sen: null, cost_price_sen: 100000,
  seat_height_prices: null, base_model: 'MODEL-A', sell_price_sen: null,
};

/** A configurator sofa arrives as ONE line carrying variants.cells. */
const SOFA_CELLS = [{ id: 'c1', moduleId: 'A1', x: 0, y: 0, rot: 0 }];
const SOFA_MODULE_PRICES = { A1: 200000 }; // RM 2000 for the single module

const line = (
  itemCode: string, itemGroup: string, variants: Record<string, unknown>, clientSen = 0,
): MfgItemForRecompute => ({ itemCode, itemGroup, qty: 1, unitPriceSen: clientSen, variants });

/* recomputeFromSnapshot(item, product, fabric, config, sofaCombos,
     sofaModulePrices, sellingFabricTiers, fabricAddonConfig, pwpBaseSen,
     pwpSofaComboIds, specialAddons, sofaModuleCostRows, modelFabricOverrides,
     compartmentFabricOverrides, trustOperatorSelling) */
const runSofa = (specials: string[], trust: boolean | 'including-zero' = false, clientSen = 0) =>
  recomputeFromSnapshot(
    line('SF-1', 'sofa', { cells: SOFA_CELLS, depth: '24', specials }, clientSen),
    sofa, null, EMPTY_CONFIG, [], SOFA_MODULE_PRICES, null, null, null, null,
    [HYDRAULIC], null, null, null, trust,
  );

const runBedframe = (
  specials: string[], sellPriceSen: number | null,
  trust: boolean | 'including-zero' = false, clientSen = 0,
) =>
  recomputeFromSnapshot(
    line('BF-1', 'bedframe', { specials }, clientSen),
    bedframe(sellPriceSen), null, EMPTY_CONFIG, null, null, null, null, null, null,
    [HYDRAULIC], null, null, null, trust,
  );

describe('SOFA: a priced add-on is now CHARGED, not only costed', () => {
  it('a native sofa build with a priced add-on charges exactly the add-on more', () => {
    const without = runSofa([]);
    const withAddon = runSofa(['Hydraulic']);
    expect(withAddon.unit_price_sen - without.unit_price_sen).toBe(ADDON_SEN);
  });

  it('THE DEFECT, stated as a number: the sofa surcharge is no longer 0 in the price', () => {
    const r = runSofa(['Hydraulic']);
    // The breakdown always knew the figure; before this fix nothing spent it.
    expect(r.special_order_sen).toBe(ADDON_SEN);
    expect(r.unit_price_sen).toBe(200000 + ADDON_SEN);
  });

  it('cost and selling now agree on the SAME surcharge (they disagreed by exactly this)', () => {
    const withoutS = runSofa([]);
    const withS = runSofa(['Hydraulic']);
    const sellingDelta = withS.unit_price_sen - withoutS.unit_price_sen;
    const costDelta = withS.unit_cost_sen - withoutS.unit_cost_sen;
    expect(costDelta).toBe(ADDON_SEN); // the cost path always did this
    expect(sellingDelta).toBe(costDelta);
  });

  it('an unpriced add-on still moves nothing — the tick alone is free', () => {
    const free: SpecialAddonDef = { code: 'Hydraulic', sellingPriceSen: 0, costPriceSen: 0 };
    const withFree = recomputeFromSnapshot(
      line('SF-1', 'sofa', { cells: SOFA_CELLS, depth: '24', specials: ['Hydraulic'] }),
      sofa, null, EMPTY_CONFIG, [], SOFA_MODULE_PRICES, null, null, null, null,
      [free], null, null, null, false,
    );
    expect(withFree.unit_price_sen).toBe(runSofa([]).unit_price_sen);
    expect(withFree.unit_cost_sen).toBe(runSofa([]).unit_cost_sen);
  });
});

describe('sell_price_sen = 0 no longer exempts a line from its own surcharge', () => {
  it('a 0-priced product with a priced add-on charges the add-on', () => {
    expect(runBedframe(['Hydraulic'], 0).unit_price_sen).toBe(ADDON_SEN);
  });

  it('a 0-priced product with NO add-on still charges nothing', () => {
    expect(runBedframe([], 0).unit_price_sen).toBe(0);
  });

  it('a normally-priced catalog line is UNCHANGED (base + surcharge, as before)', () => {
    // This branch already folded the surcharge in; the refactor must not move it.
    expect(runBedframe(['Hydraulic'], 30000).unit_price_sen).toBe(30000 + ADDON_SEN);
    expect(runBedframe([], 30000).unit_price_sen).toBe(30000);
  });
});

/* ── THE GUARD: a MIGRATED line must not re-price ────────────────────────────
   Owner ruling "A", enforced for the amendment path by #1954 using
   `linked_ac_docno IS NOT NULL` as the marker and 'including-zero' as the trust
   mode. 10,856 of 13,909 migrated lines are priced 0 and 549 of those are SOFA
   — precisely the two populations the fix above stops exempting. If the new
   arms could reach them, stamping any priced code would re-price history. */
describe("MIGRATED ('including-zero'): the new charging cannot reach it", () => {
  it('a migrated 0-priced line with a PRICED add-on keeps its stored 0', () => {
    expect(runBedframe(['Hydraulic'], 0, 'including-zero', 0).unit_price_sen).toBe(0);
    // ...where the same line authored natively now charges the add-on:
    expect(runBedframe(['Hydraulic'], 0, false, 0).unit_price_sen).toBe(ADDON_SEN);
  });

  it('a migrated SOFA line with a priced add-on keeps its AutoCount price', () => {
    // 149900 is the negotiated figure AutoCount recorded; nothing may improve on it.
    expect(runSofa(['Hydraulic'], 'including-zero', 149900).unit_price_sen).toBe(149900);
  });

  it('a migrated SOFA sibling carried at 0 stays 0 — the whole-set-on-one-line shape', () => {
    expect(runSofa(['Hydraulic'], 'including-zero', 0).unit_price_sen).toBe(0);
  });

  it('ticking a PRICED add-on changes NOTHING on a migrated line — price or drift', () => {
    /* Structural inertness, not merely a final overwrite. If the new arms had
       computed a figure and only the trust overwrite had saved the price, the
       surcharge would still have entered `drift`, and a caller that reads drift
       would 400 a migrated amendment for ticking a box.

       Stated as an equality against the same line WITHOUT the add-on, because
       that is the actual claim: the add-on is invisible here. (A migrated sofa
       drifts anyway — its AutoCount price is not the Σ of our module prices —
       so asserting `drift === false` would assert something untrue and
       unrelated.) */
    const sofaOn = runSofa(['Hydraulic'], 'including-zero', 149900);
    const sofaOff = runSofa([], 'including-zero', 149900);
    expect(sofaOn.unit_price_sen).toBe(sofaOff.unit_price_sen);
    expect(sofaOn.drift).toBe(sofaOff.drift);

    const bfOn = runBedframe(['Hydraulic'], 0, 'including-zero', 0);
    const bfOff = runBedframe([], 0, 'including-zero', 0);
    expect(bfOn.unit_price_sen).toBe(bfOff.unit_price_sen);
    expect(bfOn.drift).toBe(bfOff.drift);
    expect(bfOn.drift).toBe(false);
  });

  it('COST still books the surcharge on a migrated line — only SELLING is frozen', () => {
    /* The owner froze the customer's price, not the truth about what the thing
       costs us. Margin on a migrated line stays honest. */
    const withS = runSofa(['Hydraulic'], 'including-zero', 149900);
    const withoutS = runSofa([], 'including-zero', 149900);
    expect(withS.unit_cost_sen - withoutS.unit_cost_sen).toBe(ADDON_SEN);
  });
});
