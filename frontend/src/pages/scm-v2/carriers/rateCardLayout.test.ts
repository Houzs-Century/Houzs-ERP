import { describe, expect, it } from 'vitest';
import type { RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { hiddenZoneRules, layoutRateCard, ordinal, priceBands } from './rateCardLayout';

let n = 0;
const rule = (over: Partial<RateRule>): RateRule => ({
  id: `r${++n}`, cardId: 'c', ruleType: 'SETUP', tierPosition: null, bracketMin: null, bracketMax: null,
  zone: null, amountSen: 1000, params: null, sortOrder: 0, ...over,
});

describe('layoutRateCard', () => {
  it('lays a card out per category: tiers as 1st set / 2nd set / 3rd set and after, sofa brackets, flat charges and zone rows', () => {
    const rules = [
      rule({ ruleType: 'POSITIONAL_TIER', tierPosition: 3, amountSen: 4000 }),
      rule({ ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 14500 }),
      rule({ ruleType: 'POSITIONAL_TIER', tierPosition: 2, amountSen: 0 }),
      rule({ ruleType: 'SOFA_BRACKET', bracketMin: 4, bracketMax: null, amountSen: 19000 }),
      rule({ ruleType: 'SOFA_BRACKET', bracketMin: 1, bracketMax: 3, amountSen: 17000 }),
      rule({ ruleType: 'DISPOSE', amountSen: 3000 }),
      rule({ ruleType: 'DISMANTLE' }),
      rule({ ruleType: 'SETUP' }),
      rule({ ruleType: 'OUTSTATION', zone: 'kuching' }),
      rule({ ruleType: 'OUTSTATION_TRIP', zone: 'KUCHING ' }),
      rule({ ruleType: 'OUTSTATION_TRIP', zone: 'Bintulu' }),
    ];
    const s = layoutRateCard(rules, 'set');
    expect(s.map((x) => [x.category, x.count])).toEqual([['DELIVERY', 6], ['SITE_WORK', 2], ['SERVICE_CALL', 0], ['OUTSTATION', 3]]);

    const [tiers, sofa, extras] = s[0].blocks;
    expect(tiers.kind === 'ladder' && tiers.cells.map((c) => [c.label, c.rule.amountSen])).toEqual([['1st set', 14500], ['2nd set', 0], ['3rd set and after', 4000]]);
    expect(sofa.kind === 'ladder' && sofa.cells.map((c) => c.label)).toEqual(['1 to 3 compartments', '4 or more']);
    expect(extras.kind === 'ladder' && extras.cells.map((c) => c.label)).toEqual(['Dispose']);
    const site = s[1].blocks[0];
    expect(site.kind === 'ladder' && site.cells.map((c) => c.label)).toEqual(['Setup', 'Dismantle']);
    expect(s[2].blocks).toEqual([]);

    const zones = s[3].blocks[0];
    expect(zones.kind).toBe('zones');
    if (zones.kind !== 'zones') return;
    expect(zones.rows.map((z) => [z.zone, !!z.perOrder, !!z.perTrip])).toEqual([['Bintulu', false, true], ['kuching', true, true]]);
  });

  it('a single 1st tier reads "Each set"; a 4th tier makes 3rd plain and 4th the one that runs on', () => {
    expect(layoutRateCard([rule({ ruleType: 'POSITIONAL_TIER', tierPosition: 1 })], 'set')[0].blocks[0]).toMatchObject({ cells: [{ label: 'Each set' }] });
    const four = layoutRateCard([3, 4, 1].map((p) => rule({ ruleType: 'POSITIONAL_TIER', tierPosition: p })), 'item')[0].blocks[0];
    expect(four.kind === 'ladder' && four.cells.map((c) => c.label)).toEqual(['1st item', '3rd item', '4th item and after']);
    expect(four.title).toBe('Per item, by position on the trip');
  });

  it('flags two rules for the same thing, and keeps the hidden zone rule listed', () => {
    const rules = [
      rule({ ruleType: 'SETUP', amountSen: 1000 }), rule({ ruleType: 'SETUP', amountSen: 2000 }),
      rule({ ruleType: 'OUTSTATION', zone: 'MIRI' }), rule({ ruleType: 'OUTSTATION', zone: 'miri' }),
    ];
    const s = layoutRateCard(rules, 'set');
    const site = s[1].blocks[0];
    expect(site.kind === 'ladder' && site.cells.every((c) => c.duplicate)).toBe(true);
    const zones = s[3].blocks[0];
    if (zones.kind !== 'zones') throw new Error('zones');
    expect(zones.rows).toHaveLength(1);
    expect(zones.rows[0].duplicate).toBe(true);
    expect(hiddenZoneRules(rules, zones.rows).map((r) => r.id)).toEqual([rules[3].id]);
  });

  it('an unknown rule type is shown under Delivery, not dropped', () => {
    const s = layoutRateCard([rule({ ruleType: 'NEW_KIND' as RateRule['ruleType'] })], 'set');
    expect(s[0].count).toBe(1);
    expect(s[0].blocks[0]).toMatchObject({ id: 'flat', cells: [{ label: 'NEW_KIND' }] });
  });
});

describe('priceBands', () => {
  it('groups the towns by what they cost, cheapest first, each band A to Z, per order and per trip apart', () => {
    const rules = [
      rule({ ruleType: 'OUTSTATION', zone: 'BINTULU', amountSen: 17500 }),
      rule({ ruleType: 'OUTSTATION', zone: 'BAU', amountSen: 6000 }),
      rule({ ruleType: 'OUTSTATION', zone: 'BATU KITANG', amountSen: 4000 }),
      rule({ ruleType: 'OUTSTATION', zone: 'BATU KAWAH', amountSen: 4000 }),
      rule({ ruleType: 'OUTSTATION', zone: 'BIAWAK', amountSen: 6000 }),
      rule({ ruleType: 'OUTSTATION_TRIP', zone: 'MIRI', amountSen: 12000 }),
    ];
    const zones = layoutRateCard(rules, 'set')[3].blocks[0];
    if (zones.kind !== 'zones') throw new Error('zones');
    const perOrder = priceBands(zones.rows, 'perOrder');
    expect(perOrder.map((b) => [b.amountSen, b.towns.map((t) => t.zone)])).toEqual([
      [4000, ['BATU KAWAH', 'BATU KITANG']],
      [6000, ['BAU', 'BIAWAK']],
      [17500, ['BINTULU']],
    ]);
    expect(priceBands(zones.rows, 'perTrip').map((b) => [b.amountSen, b.towns.map((t) => t.zone)])).toEqual([[12000, ['MIRI']]]);
  });

  it('marks a town priced twice only on the kind that is doubled', () => {
    const rules = [
      rule({ ruleType: 'OUTSTATION', zone: 'MIRI', amountSen: 9000 }),
      rule({ ruleType: 'OUTSTATION', zone: 'miri', amountSen: 9500 }),
      rule({ ruleType: 'OUTSTATION_TRIP', zone: 'MIRI', amountSen: 12000 }),
    ];
    const zones = layoutRateCard(rules, 'set')[3].blocks[0];
    if (zones.kind !== 'zones') throw new Error('zones');
    expect(priceBands(zones.rows, 'perOrder')[0].towns[0].twice).toBe(true);
    expect(priceBands(zones.rows, 'perTrip')[0].towns[0].twice).toBe(false);
  });
});

describe('labels', () => {
  it('writes ordinals the English way, teens included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st']);
  });

  it('names a sofa bracket by its compartments, and a per-trip card its tier "Each trip"', () => {
    const sofa = layoutRateCard([
      rule({ ruleType: 'SOFA_BRACKET', bracketMin: 2, bracketMax: 2 }),
      rule({ ruleType: 'SOFA_BRACKET', bracketMin: 1, bracketMax: null }),
    ], 'set')[0].blocks[0];
    expect(sofa.kind === 'ladder' && sofa.cells.map((c) => c.label)).toEqual(['Any sofa', '2 compartments']);
    const trip = layoutRateCard([rule({ ruleType: 'POSITIONAL_TIER', tierPosition: 1 })], 'trip')[0].blocks[0];
    expect(trip).toMatchObject({ title: 'Per trip', cells: [{ label: 'Each trip' }] });
  });
});
