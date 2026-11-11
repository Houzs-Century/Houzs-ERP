import { describe, expect, it } from 'vitest';
import type { CostBreakdown, RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { chargingUnit, settingsSentence } from './cardSettings';
import {
  COUNT_ERROR, EMPTY_FORM, SOFA_ERROR, groupBreakdown, lineLabel, outstationTowns, pricedTypes, readFacts,
} from './priceCheckFacts';
import { FLAT_ORDER } from './rateCardLayout';

let n = 0;
const rule = (over: Partial<RateRule>): RateRule => ({
  id: `r${++n}`, cardId: 'c', ruleType: 'POSITIONAL_TIER', tierPosition: 1, bracketMin: null, bracketMax: null,
  zone: null, amountSen: 1000, params: null, sortOrder: 0, ...over,
});
const SET_CARD = { basis: 'SET', aggregation: 'UNIT' } as const;

describe('settingsSentence', () => {
  it('says the card’s settings in one line', () => {
    expect(settingsSentence({ ...SET_CARD, minChargeSen: null, capSen: null, rounding: 'NONE' }))
      .toBe('Charged per set (frame + mattress) · No minimum · No cap · No rounding');
    expect(settingsSentence({ basis: 'ITEM', aggregation: 'UNIT', minChargeSen: 5000, capSen: 50000, rounding: 'NEAREST_RM' }))
      .toBe('Charged per item · Minimum RM 50.00 · Cap RM 500.00 · Rounded to the nearest RM');
    expect(settingsSentence({ basis: 'SET', aggregation: 'TRIP', minChargeSen: null, capSen: null, rounding: 'NEAREST_10C' }))
      .toBe('Charged per trip (flat, whatever it carries) · No minimum · No cap · Rounded to the nearest 10 sen');
  });

  it('names what the tier ladder counts', () => {
    expect(chargingUnit(SET_CARD)).toBe('set');
    expect(chargingUnit({ basis: 'ITEM', aggregation: 'UNIT' })).toBe('item');
    expect(chargingUnit({ basis: 'SET', aggregation: 'DROP' })).toBe('drop');
    expect(chargingUnit({ basis: 'ITEM', aggregation: 'CUSTOMER' })).toBe('customer');
  });
});

describe('readFacts', () => {
  const priced = pricedTypes([
    rule({}), rule({ ruleType: 'SOFA_BRACKET', bracketMin: 1, bracketMax: 3 }), rule({ ruleType: 'DISPOSE' }),
    rule({ ruleType: 'OUTSTATION', zone: 'BINTULU' }),
  ]);

  it('reads only the boxes the card prices, a blank box as 0', () => {
    const r = readFacts({ count: '3', sofas: '3, 6', town: 'BINTULU', counts: { DISPOSE: '', SETUP: '2' } }, SET_CARD, priced);
    expect(r).toEqual({ ok: true, facts: { setCount: 3, sofaCompartments: [3, 6], disposeCount: 0, destinationZone: 'BINTULU' } });
  });

  it('counts items on a per-item card, nothing on a per-trip card, and in town is no zone', () => {
    expect(readFacts(EMPTY_FORM, { basis: 'ITEM', aggregation: 'UNIT' }, new Set())).toEqual({ ok: true, facts: { itemCount: 1, destinationZone: null } });
    expect(readFacts(EMPTY_FORM, { basis: 'SET', aggregation: 'TRIP' }, new Set())).toEqual({ ok: true, facts: { destinationZone: null } });
  });

  it('fills the server’s own fact name for each flat price the card carries', () => {
    const counts = Object.fromEntries(FLAT_ORDER.map((t) => [t, '2']));
    const r = readFacts({ ...EMPTY_FORM, counts }, { basis: 'SET', aggregation: 'TRIP' }, new Set(FLAT_ORDER));
    expect(r.ok && Object.keys(r.facts).sort()).toEqual([
      'destinationZone', 'dismantleCount', 'disposeCount', 'inspectionCount', 'pickupCount', 'serviceCount', 'setupCount',
      'supplierPickupCount', 'transferCount',
    ]);
    expect(r.ok && r.facts.supplierPickupCount).toBe(2);
  });

  it('refuses a count that is not a whole number from 0 to 99, and sofas that are not numbers', () => {
    expect(readFacts({ ...EMPTY_FORM, count: '1.5' }, SET_CARD, priced)).toEqual({ ok: false, errors: { count: COUNT_ERROR } });
    expect(readFacts({ ...EMPTY_FORM, count: '100' }, SET_CARD, priced)).toEqual({ ok: false, errors: { count: COUNT_ERROR } });
    expect(readFacts({ ...EMPTY_FORM, counts: { DISPOSE: '-1' } }, SET_CARD, priced)).toEqual({ ok: false, errors: { DISPOSE: COUNT_ERROR } });
    expect(readFacts({ ...EMPTY_FORM, sofas: '3, six' }, SET_CARD, priced)).toEqual({ ok: false, errors: { sofas: SOFA_ERROR } });
    expect(readFacts({ ...EMPTY_FORM, sofas: '0' }, SET_CARD, priced)).toEqual({ ok: false, errors: { sofas: SOFA_ERROR } });
  });
});

describe('outstationTowns', () => {
  it('lists the card’s towns once each, A to Z, whether priced per order or per trip', () => {
    expect(outstationTowns([
      rule({ ruleType: 'OUTSTATION', zone: 'MIRI' }), rule({ ruleType: 'OUTSTATION_TRIP', zone: 'miri' }),
      rule({ ruleType: 'OUTSTATION', zone: 'BAU' }), rule({ ruleType: 'SETUP' }),
    ])).toEqual(['BAU', 'MIRI']);
  });
});

describe('groupBreakdown', () => {
  const b: CostBreakdown = {
    subtotalSen: 55000, totalSen: 55000,
    lines: [
      { ruleType: 'POSITIONAL_TIER', label: '1st set', amountSen: 14500, detail: { position: 1, tierPosition: 1 } },
      { ruleType: 'POSITIONAL_TIER', label: '2nd set', amountSen: 0, detail: { position: 2, tierPosition: 2 } },
      { ruleType: 'POSITIONAL_TIER', label: '21th set', amountSen: 4000, detail: { position: 21, tierPosition: 3 } },
      { ruleType: 'SOFA_BRACKET', label: 'Sofa 6-compartment (4+ band)', amountSen: 19000, detail: { compartments: 6 } },
      { ruleType: 'OUTSTATION', label: 'Outstation BINTULU', amountSen: 17500, detail: { zone: 'BINTULU' } },
      { ruleType: 'SUPPLIER_PICKUP', label: 'Supplier pickup x2', amountSen: 10000, detail: { count: 2, eachSen: 5000 } },
      { ruleType: 'ROUNDING', label: 'Rounding (nearest RM)', amountSen: -50, detail: { rounding: 'NEAREST_RM' } },
    ],
  };

  it('groups the lines the way the tabs are, in the tiles’ words, with the adjustments last', () => {
    const groups = groupBreakdown(b, 'set');
    expect(groups.map((g) => [g.title, g.lines.map((l) => l.label)])).toEqual([
      ['Delivery', ['1st set', '2nd set', '21st set', 'Sofa, 6 compartments']],
      ['Outstation', ['BINTULU, per order']],
      ['Service calls', ['Supplier pickup × 2']],
      ['Minimum, cap and rounding', ['Rounding (nearest RM)']],
    ]);
  });

  it('keeps the engine’s own label when a line carries no detail', () => {
    expect(lineLabel({ ruleType: 'OUTSTATION_TRIP', label: 'Outstation trip MIRI', amountSen: 1 }, 'set')).toBe('Outstation trip MIRI');
    expect(lineLabel({ ruleType: 'OUTSTATION_TRIP', label: 'x', amountSen: 1, detail: { zone: 'MIRI' } }, 'set')).toBe('MIRI, per trip');
    expect(lineLabel({ ruleType: 'OVERAGE', label: 'x', amountSen: 1, detail: { position: 12, cap: 10 } }, 'item')).toBe('12th item, beyond the first 10');
  });
});
