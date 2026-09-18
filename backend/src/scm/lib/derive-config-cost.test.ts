import { describe, expect, it } from 'vitest';
import { deriveMasterConfigCostFromSuppliers, configCostChanged } from './derive-config-cost';
import type { MaintenanceConfig } from '../shared/mfg-pricing';

const cfg = (over: Partial<MaintenanceConfig>): MaintenanceConfig => ({
  divanHeights: [], legHeights: [], totalHeights: [], gaps: [],
  specials: [], sofaLegHeights: [], sofaSpecials: [], sofaSizes: [], ...over,
});

describe('deriveMasterConfigCostFromSuppliers — COST-only max', () => {
  it('no supplier configs -> master unchanged', () => {
    const master = cfg({ specials: [{ value: 'PIPING', priceSen: 1000, sellingPriceSen: 3000 }] });
    expect(deriveMasterConfigCostFromSuppliers(master, [])).toEqual(master);
  });

  it('maxes priceSen across suppliers but PRESERVES the master sellingPriceSen', () => {
    const master = cfg({ specials: [{ value: 'PIPING', priceSen: 1000, sellingPriceSen: 3000, active: true }] });
    const s1 = cfg({ specials: [{ value: 'PIPING', priceSen: 1500 }] });
    const s2 = cfg({ specials: [{ value: 'PIPING', priceSen: 2500 }] });
    const out = deriveMasterConfigCostFromSuppliers(master, [s1, s2]);
    expect(out.specials).toEqual([{ value: 'PIPING', priceSen: 2500, sellingPriceSen: 3000, active: true }]);
  });

  it('a supplier lower than the master keeps the master cost', () => {
    const master = cfg({ legHeights: [{ value: '4in', priceSen: 5000 }] });
    const s1 = cfg({ legHeights: [{ value: '4in', priceSen: 3000 }] });
    expect(deriveMasterConfigCostFromSuppliers(master, [s1]).legHeights).toEqual([{ value: '4in', priceSen: 5000 }]);
  });

  it('a supplier-only entry is added COST-only (no selling)', () => {
    const master = cfg({ divanHeights: [] });
    const s1 = cfg({ divanHeights: [{ value: '6in', priceSen: 4000, sellingPriceSen: 9999 }] });
    // the supplier's SELLING is NOT carried onto the master — cost only.
    expect(deriveMasterConfigCostFromSuppliers(master, [s1]).divanHeights).toEqual([{ value: '6in', priceSen: 4000 }]);
  });

  it('never touches the unpriced pools (gaps / sofaSizes) or selling pools', () => {
    const master = cfg({ gaps: ['G1', 'G2'], sofaSizes: ['2S'], specials: [{ value: 'X', priceSen: 100, sellingPriceSen: 7000 }] });
    const s1 = cfg({ specials: [{ value: 'X', priceSen: 200 }] });
    const out = deriveMasterConfigCostFromSuppliers(master, [s1]);
    expect(out.gaps).toEqual(['G1', 'G2']);
    expect(out.sofaSizes).toEqual(['2S']);
    expect(out.specials[0].sellingPriceSen).toBe(7000); // selling preserved
    expect(out.specials[0].priceSen).toBe(200);         // cost maxed
  });

  it('does not mutate the input master', () => {
    const master = cfg({ specials: [{ value: 'X', priceSen: 100 }] });
    deriveMasterConfigCostFromSuppliers(master, [cfg({ specials: [{ value: 'X', priceSen: 999 }] })]);
    expect(master.specials[0].priceSen).toBe(100);
  });
});

describe('configCostChanged', () => {
  it('same cost -> false, changed cost -> true, selling-only change -> false', () => {
    const a = cfg({ specials: [{ value: 'X', priceSen: 100, sellingPriceSen: 1 }] });
    const same = cfg({ specials: [{ value: 'X', priceSen: 100, sellingPriceSen: 999 }] });
    const dearer = cfg({ specials: [{ value: 'X', priceSen: 200 }] });
    expect(configCostChanged(a, same)).toBe(false);  // only selling differs -> not a cost change
    expect(configCostChanged(a, dearer)).toBe(true);
    expect(configCostChanged(null, a)).toBe(true);
  });
});
