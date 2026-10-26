/* HC-0134: special_addons was read for every company and keyed by code, so a
 * 2990 selling price on a shared code priced the Houzs Century line. */
import { describe, expect, it } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { compartmentPricesFromRow, loadSpecialAddons, recomputeFromSnapshot, type MfgItemForRecompute, type ProductRowLite } from './mfg-pricing-recompute';
import { buildSpecialsPoolFromAddons, type MaintenanceConfig, type SpecialAddonDef } from '../shared/mfg-pricing';

const ROWS = [
  { company_id: 1, code: 'Divan Full Cover', selling_price_sen: 0, cost_price_sen: 0, option_groups: [], active: true },
  { company_id: 2, code: 'Divan Full Cover', selling_price_sen: 12500, cost_price_sen: 0, option_groups: [], active: true },
];

describe('loadSpecialAddons', () => {
  it("reads only the order's own company's add-ons", async () => {
    const defs = await loadSpecialAddons(fakeSb({ special_addons: ROWS }), 1);
    expect(defs.map((d) => [d.code, d.sellingPriceSen])).toEqual([['Divan Full Cover', 0]]);
  });

  it('carries the compartment prices, with canonical codes', async () => {
    const defs = await loadSpecialAddons(fakeSb({ special_addons: [
      { ...ROWS[1], code: 'Latex Seat', compartment_prices: [{ compartment: 'L-LHF', sellingPriceSen: 70000 }] },
    ] }), 2);
    expect(defs[0]!.compartmentPrices).toEqual([{ compartment: 'L(LHF)', sellingPriceSen: 70000 }]);
  });
});

describe('compartmentPricesFromRow', () => {
  it('drops an entry that cannot price — no code, or a price that is not whole sen', () => {
    expect(compartmentPricesFromRow([
      { compartment: 'CNR', sellingPriceSen: 80000 },
      { compartment: '', sellingPriceSen: 1 },
      { compartment: '1NA', sellingPriceSen: 'x' },
      { compartment: '1S', sellingPriceSen: 1.5 },
    ])).toEqual([{ compartment: 'CNR', sellingPriceSen: 80000 }]);
    expect(compartmentPricesFromRow(null)).toEqual([]);
  });
});

/* "Detect by compartment" (2990 owner 2026-10-26) — like the per-compartment
   fabric prices, an add-on takes another price when the sofa carries a listed
   compartment: a Latex Seat on a sofa with a corner. */
const LATEX: SpecialAddonDef = {
  code: 'Latex Seat',
  sellingPriceSen: 50000,
  costPriceSen: 30000,
  optionGroups: [{ label: 'Density', choices: [{ label: 'Firm', extraSen: 5000 }] }],
  compartmentPrices: [
    { compartment: 'CNR', sellingPriceSen: 80000 },
    { compartment: 'L(LHF)', sellingPriceSen: 70000 },
  ],
};

describe('buildSpecialsPoolFromAddons — by compartment', () => {
  it('a build with the compartment takes its price; choice extras stack; cost stays', () => {
    expect(buildSpecialsPoolFromAddons([LATEX], ['Latex Seat'], { 'Latex Seat': ['Firm'] }, ['3S', 'CNR']))
      .toEqual([{ value: 'Latex Seat', priceSen: 30000, sellingPriceSen: 85000 }]);
  });

  it('several listed compartments → the highest; none → the base; no build → the base', () => {
    const sell = (b: string[] | null) => buildSpecialsPoolFromAddons([LATEX], ['Latex Seat'], null, b)[0]!.sellingPriceSen;
    expect(sell(['L(LHF)', 'CNR'])).toBe(80000);
    expect(sell(['3S'])).toBe(50000);
    expect(sell(null)).toBe(50000);
  });
});

const EMPTY_CONFIG: MaintenanceConfig = {
  divanHeights: [], legHeights: [], totalHeights: [], gaps: [],
  specials: [], sofaLegHeights: [], sofaSpecials: [], sofaSizes: [],
};
const SOFA: ProductRowLite = {
  code: 'MODEL-A-3S', category: 'SOFA', base_price_sen: null, price1_sen: null, cost_price_sen: null,
  seat_height_prices: null, base_model: 'MODEL-A', sell_price_sen: null,
};
const MODULE_PRICES = { '3S': 300000, CNR: 150000, '2A(RHF)': 250000 };

/* recomputeFromSnapshot(item, product, fabric, config, sofaCombos,
     sofaModulePrices, sellingFabricTiers, fabricAddonConfig, pwpBaseSen,
     pwpSofaComboIds, specialAddons, sofaModuleCostRows, ...) */
const runBuild = (moduleIds: string[], clientSen: number) =>
  recomputeFromSnapshot(
    {
      itemCode: 'MODEL-A-3S', itemGroup: 'sofa', qty: 1, unitPriceSen: clientSen,
      variants: { depth: '24', specials: ['Latex Seat'], cells: moduleIds.map((moduleId, i) => ({ id: `c${i}`, moduleId, x: i * 100, y: 0, rot: 0 })) } as MfgItemForRecompute['variants'],
    },
    SOFA, null, EMPTY_CONFIG, [], MODULE_PRICES, null, null, null, null, [LATEX], null, null, null,
  );

describe('recomputeFromSnapshot — an add-on priced by compartment', () => {
  it('a POS sofa with a corner is charged the corner price, and the tablet agreeing passes the gate', () => {
    const r = runBuild(['3S', 'CNR', '2A(RHF)'], 300000 + 150000 + 250000 + 80000);
    expect(r.special_order_sen).toBe(80000);
    expect(r.unit_price_sen).toBe(780000);
    expect(r.drift).toBe(false);
    expect(r.custom_specials).toEqual([{ description: 'Latex Seat', surchargeSen: 80000 }]);
  });

  it('a tablet still on the base price drifts on a corner sofa', () => {
    expect(runBuild(['3S', 'CNR', '2A(RHF)'], 300000 + 150000 + 250000 + 50000).drift).toBe(true);
  });

  it('a sofa without a listed compartment keeps the base price', () => {
    const r = runBuild(['3S'], 300000 + 50000);
    expect(r.unit_price_sen).toBe(350000);
    expect(r.drift).toBe(false);
  });

  it('a split module line (cells stripped) prices on the compartments its caller passes', () => {
    const run = (buildCompartments?: string[]) => recomputeFromSnapshot(
      { itemCode: 'MODEL-A-CNR', itemGroup: 'sofa', qty: 1, unitPriceSen: 150000, variants: { specials: ['Latex Seat'], buildKey: 'build-1' } as MfgItemForRecompute['variants'], buildCompartments },
      SOFA, null, EMPTY_CONFIG, null, null, null, null, null, null, [LATEX], null, null, null,
    );
    expect(run(['3S', 'CNR']).special_order_sen).toBe(80000);
    expect(run().special_order_sen).toBe(50000);
  });
});
