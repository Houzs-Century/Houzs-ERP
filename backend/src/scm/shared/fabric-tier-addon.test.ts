// fabric-tier-addon calls itself "the SOLE source of truth for the POS selling
// fabric-tier add-on" — POST /mfg-sales-orders recomputes with it on the server
// and the POS configurator prices with it on the client, so the customer's
// quoted price and the order's stored price are the same function or they are a
// dispute. It had no test. Neither did resolveFabricTierOverride, which decides
// WHICH delta that function is handed.
//
// Every case asserts a price, and each has been inverted in the source to
// confirm it fails.

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
    // PRICE_1 is the price already in the model's price list. Charging a delta
    // on top of it would double-bill the base fabric on every order.
    for (const tier of ['PRICE_1', null, undefined] as const) {
      expect(fabricTierAddon('SOFA', tier, CONFIG)).toBe(0);
      expect(fabricTierAddon('BEDFRAME', tier, CONFIG)).toBe(0);
    }
  });

  it('charges the SOFA delta for a sofa and the BEDFRAME delta for a bedframe', () => {
    // The two categories have different numbers on purpose; crossing them
    // misprices every order of the cheaper category upward and the dearer
    // downward, and nothing downstream would notice.
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG)).toBe(300);
    expect(fabricTierAddon('SOFA', 'PRICE_3', CONFIG)).toBe(600);
    expect(fabricTierAddon('BEDFRAME', 'PRICE_2', CONFIG)).toBe(150);
    expect(fabricTierAddon('BEDFRAME', 'PRICE_3', CONFIG)).toBe(250);
  });

  it('a per-Model override REPLACES the global delta, tier by tier', () => {
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG, { tier2Delta: 450, tier3Delta: null })).toBe(450);
    // tier3 was left null on the same override, so tier 3 still inherits.
    expect(fabricTierAddon('SOFA', 'PRICE_3', CONFIG, { tier2Delta: 450, tier3Delta: null })).toBe(600);
  });

  it('an explicit override of 0 is a FREE upgrade, not "inherit the global"', () => {
    // The distinction the whole override type exists for. Folding 0 into
    // "nothing set" charges RM 300 for an upgrade the owner priced at zero, on
    // every order of that model, and the number looks perfectly plausible.
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG, { tier2Delta: 0, tier3Delta: null })).toBe(0);
    expect(fabricTierAddon('BEDFRAME', 'PRICE_3', CONFIG, { tier2Delta: null, tier3Delta: 0 })).toBe(0);
  });

  it('never returns a negative charge, and never a fraction of a ringgit', () => {
    // The return is WHOLE MYR that callers multiply by qty and ×100 into sen.
    // A negative would be a discount nobody authorised; a fraction would put
    // sub-sen noise into the order total.
    expect(fabricTierAddon('SOFA', 'PRICE_2', { ...CONFIG, sofaTier2Delta: -300 })).toBe(0);
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG, { tier2Delta: -1, tier3Delta: null })).toBe(0);
    expect(fabricTierAddon('SOFA', 'PRICE_2', { ...CONFIG, sofaTier2Delta: 300.9 })).toBe(300);
  });
});

describe('resolveFabricTierOverride', () => {
  const ovr = (tier2: number | null, tier3: number | null) => ({ tier2Delta: tier2, tier3Delta: tier3 });

  it('is null when neither the Model nor any compartment overrides anything', () => {
    // Null is what makes fabricTierAddon fall back to the global standard, so
    // returning an all-null object instead would still price correctly but a
    // {0,0} object would silently make every such sofa a free upgrade.
    expect(resolveFabricTierOverride(['SEAT'], null, new Map())).toBeNull();
    expect(resolveFabricTierOverride(['SEAT'], ovr(null, null), new Map())).toBeNull();
  });

  it('takes the HIGHEST delta across the Model and every matching compartment', () => {
    // "Take the highest" is the owner's rule: a build containing any compartment
    // that costs more to upholster is priced at that compartment. Taking the
    // lowest — or the first — undercharges every mixed build.
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
    // ...and loses the moment a real price is on the same build.
    expect(resolveFabricTierOverride(['SEAT'], ovr(250, null), comps)).toEqual({ tier2Delta: 250, tier3Delta: 0 });
  });

  it('feeds straight into the price: highest compartment override, then the addon', () => {
    // The two functions are only ever used together, and this is the number the
    // customer is quoted.
    const comps = new Map([['ARM', ovr(750, null)]]);
    const resolved = resolveFabricTierOverride(['SEAT', 'ARM'], null, comps);
    expect(fabricTierAddon('SOFA', 'PRICE_2', CONFIG, resolved)).toBe(750);
    // tier 3 had no override anywhere, so it falls back to the global 600.
    expect(fabricTierAddon('SOFA', 'PRICE_3', CONFIG, resolved)).toBe(600);
  });
});
