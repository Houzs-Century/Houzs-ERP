
import { describe, it, expect } from 'vitest';
import { fabricTierAddon, type FabricTierAddonConfig } from './fabric-tier-addon';
import { resolveFabricTierOverride } from './fabric-tier-override-resolve';

const CONFIG: FabricTierAddonConfig = {
  sofaTier2Delta: 300,
  sofaTier3Delta: 600,
  bedframeTier2Delta: 150,
  bedframeTier3Delta: 250,
};

describe('fabricTierAddon', () => {
  it('charges nothing for the base tier or an absent one', () => {
    for (const tier of ['PRICE_1', null, undefined] as const) {
      expect(fabricTierAddon('SOFA', tier, CONFIG)).toBe(0);
      expect(fabricTierAddon('BEDFRAME', tier, CONFIG)).toBe(0);
    }
  });

  it('charges the SOFA delta for a sofa and the BEDFRAME delta for a bedframe', () => {
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG)).toBe(300);
    expect(fabricTierAddon('SOFA', 'PRICE_3', CONFIG)).toBe(600);
    expect(fabricTierAddon('BEDFRAME', 'PRICE_2', CONFIG)).toBe(150);
    expect(fabricTierAddon('BEDFRAME', 'PRICE_3', CONFIG)).toBe(250);
  });

  it('a per-Model override REPLACES the global delta, tier by tier', () => {
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG, { tier2Delta: 450, tier3Delta: null })).toBe(450);
    expect(fabricTierAddon('SOFA', 'PRICE_3', CONFIG, { tier2Delta: 450, tier3Delta: null })).toBe(600);
  });

  it('an explicit override of 0 is a FREE upgrade, not "inherit the global"', () => {
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG, { tier2Delta: 0, tier3Delta: null })).toBe(0);
    expect(fabricTierAddon('BEDFRAME', 'PRICE_3', CONFIG, { tier2Delta: null, tier3Delta: 0 })).toBe(0);
  });

  it('never returns a negative charge, and never a fraction of a ringgit', () => {
    expect(fabricTierAddon('SOFA', 'PRICE_2', { ...CONFIG, sofaTier2Delta: -300 })).toBe(0);
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG, { tier2Delta: -1, tier3Delta: null })).toBe(0);
    expect(fabricTierAddon('SOFA', 'PRICE_2', { ...CONFIG, sofaTier2Delta: 300.9 })).toBe(300);
  });
});

describe('resolveFabricTierOverride', () => {
  const ovr = (tier2: number | null, tier3: number | null) => ({ tier2Delta: tier2, tier3Delta: tier3 });

  it('is null when neither the Model nor any compartment overrides anything', () => {
    expect(resolveFabricTierOverride(['SEAT'], null, new Map())).toBeNull();
    expect(resolveFabricTierOverride(['SEAT'], ovr(null, null), new Map())).toBeNull();
  });

  it('takes the HIGHEST delta across the Model and every matching compartment', () => {
    const comps = new Map([
      ['SEAT', ovr(200, 400)],
      ['ARM', ovr(500, 300)],
    ]);
    expect(resolveFabricTierOverride(['SEAT', 'ARM'], ovr(100, 100), comps)).toEqual({ tier2Delta: 500, tier3Delta: 400 });
  });

  it('ignores compartments the build does not contain', () => {
    const comps = new Map([['BACK', ovr(900, 900)]]);
    expect(resolveFabricTierOverride(['SEAT'], ovr(100, 200), comps)).toEqual({ tier2Delta: 100, tier3Delta: 200 });
  });

  it('a 0 wins only when nothing pricier is set', () => {
    const comps = new Map([['SEAT', ovr(0, 0)]]);
    expect(resolveFabricTierOverride(['SEAT'], null, comps)).toEqual({ tier2Delta: 0, tier3Delta: 0 });
    expect(resolveFabricTierOverride(['SEAT'], ovr(250, null), comps)).toEqual({ tier2Delta: 250, tier3Delta: 0 });
  });

  it('feeds straight into the price: highest compartment override, then the addon', () => {
    const comps = new Map([['ARM', ovr(750, null)]]);
    const resolved = resolveFabricTierOverride(['SEAT', 'ARM'], null, comps);
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG, resolved)).toBe(750);
    expect(fabricTierAddon('SOFA', 'PRICE_3', CONFIG, resolved)).toBe(600);
  });
});
