// Areas on a rate card (mig 20261111T1000; owner 2026-11-11 on the 3PL quotations:
// 做). A carrier's quotation prices each group of towns with its own ladder — the
// first sets, each item after, a sofa, an L-shape — not the city ladder plus one
// surcharge. The amounts below are made up; the shape is the quotations'.
import { describe, expect, test } from 'vitest';
import { areaOf, computeDeliveryCost, type RateCardSpec } from './delivery-rate-card';

const FAR = 'area-far';
const NEAR = 'area-near';
const card: RateCardSpec = {
  basis: 'SET',
  areas: [
    { id: FAR, name: 'Bintulu / Tatau', towns: ['BINTULU', 'TATAU'] },
    { id: NEAR, name: 'Marudi / Subis', towns: ['MARUDI', 'SUBIS'] },
  ],
  rules: [
    /* The card's own: the city ladder. */
    { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 10_000 },
    { ruleType: 'POSITIONAL_TIER', tierPosition: 2, amountSen: 0 },
    { ruleType: 'POSITIONAL_TIER', tierPosition: 3, amountSen: 3_000 },
    { ruleType: 'SOFA_BRACKET', bracketMin: 1, bracketMax: 3, amountSen: 12_000 },
    { ruleType: 'SOFA_BRACKET', bracketMin: 4, bracketMax: null, amountSen: 14_000 },
    { ruleType: 'DISPOSE', amountSen: 5_000 },
    { ruleType: 'OUTSTATION', zone: 'LABUAN', amountSen: 6_000 },
    /* The far area's own ladder and sofas. */
    { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 30_000, areaId: FAR },
    { ruleType: 'POSITIONAL_TIER', tierPosition: 2, amountSen: 0, areaId: FAR },
    { ruleType: 'POSITIONAL_TIER', tierPosition: 3, amountSen: 6_000, areaId: FAR },
    { ruleType: 'SOFA_BRACKET', bracketMin: 1, bracketMax: 3, amountSen: 35_000, areaId: FAR },
    { ruleType: 'SOFA_BRACKET', bracketMin: 4, bracketMax: null, amountSen: 40_000, areaId: FAR },
    /* The near area: a dearer first unit than the city, cheaper than the far one. */
    { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 20_000, areaId: NEAR },
  ],
};

describe('a rate card area prices with its own ladder', () => {
  test('in the far area, 3 sets and a 3-seater cost the area\'s prices, not the city\'s', () => {
    const r = computeDeliveryCost(card, { setCount: 3, sofaCompartments: [3], addressText: 'Lot 12, Jalan Tun Ahmad Zaidi, 97000 Bintulu' });
    expect(r.totalSen).toBe(30_000 + 0 + 6_000 + 35_000);
    expect(r.area).toEqual({ id: FAR, name: 'Bintulu / Tatau' });
    expect(r.lines.map((l) => l.label)).toEqual([
      '1st set · Bintulu / Tatau', '2nd set · Bintulu / Tatau', '3rd set · Bintulu / Tatau', 'Sofa 3-compartment (1-3 band) · Bintulu / Tatau',
    ]);
  });

  test('the city prices as before when the address names no area', () => {
    const r = computeDeliveryCost(card, { setCount: 3, sofaCompartments: [3], addressText: 'Jalan Stutong, 93350 Kuching' });
    expect(r.totalSen).toBe(10_000 + 0 + 3_000 + 12_000);
    expect(r.area).toBeNull();
  });

  test('a rule type the area does not price falls back to the card: the near area has a ladder but no sofa or dispose of its own', () => {
    const r = computeDeliveryCost(card, { setCount: 1, sofaCompartments: [5], disposeCount: 1, addressText: 'Kampung Subis' });
    expect(r.lines.map((l) => [l.label, l.amountSen])).toEqual([
      ['1st set · Marudi / Subis', 20_000],
      ['Sofa 5-compartment (4+ band)', 14_000],
      ['Dispose', 5_000],
    ]);
  });

  test('a town surcharge still adds on top, as a customs fee does', () => {
    const labuan: RateCardSpec = { ...card, areas: [...card.areas!, { id: 'area-labuan', name: 'Sandakan … Labuan', towns: ['LABUAN'] }],
      rules: [...card.rules, { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 30_000, areaId: 'area-labuan' }] };
    const r = computeDeliveryCost(labuan, { setCount: 1, addressText: 'Jalan Merdeka, 87000 Labuan' });
    expect(r.totalSen).toBe(30_000 + 6_000);
  });

  test('two areas in one trip\'s addresses: the dearer one, once; the caller can name the area', () => {
    expect(areaOf(card, { addressText: 'Marudi | Bintulu' })?.id).toBe(FAR);
    expect(areaOf(card, { addressText: 'Bintulu', areaId: NEAR })?.id).toBe(NEAR);
    expect(areaOf(card, { addressText: 'Bintuluan Heights' })).toBeNull();
    expect(computeDeliveryCost(card, { setCount: 1, areaId: FAR }).totalSen).toBe(30_000);
  });

  test('a card with no areas prices exactly as it did', () => {
    const plain: RateCardSpec = { basis: 'SET', rules: card.rules.filter((r) => r.areaId == null) };
    const r = computeDeliveryCost(plain, { setCount: 3, sofaCompartments: [3], addressText: 'Bintulu' });
    expect(r.totalSen).toBe(10_000 + 0 + 3_000 + 12_000);
    expect(r.area).toBeNull();
  });
});
