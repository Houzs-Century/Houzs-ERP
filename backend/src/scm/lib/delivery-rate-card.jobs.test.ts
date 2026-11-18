// Every job a carrier is paid for, and what an outstation price applies to.
// Owner 2026-11-18: "the rate card is bound to all my jobs to compute my cost"
// and "check what Outstation applies to". The amounts are made up.
import { describe, expect, test } from 'vitest';
import { computeDeliveryCost, outstationApplies, type DeliveryFacts, type RateCardSpec } from './delivery-rate-card';
import { BILLABLE_JOB_TYPES, DISPATCHABLE_JOB_TYPES, NON_BILLABLE_JOB_TYPES, RULE_JOB_TYPE, appliesToOf } from './rate-rule-taxonomy';
import { jobStopFacts, stopJob, JOB_COUNT_FACT } from './trip-stop-jobs';

const SAMPLE_CARD: RateCardSpec = {
  basis: 'SET',
  aggregation: 'UNIT',
  minChargeSen: 8_000,
  capSen: 200_000,
  rounding: 'NEAREST_RM',
  places: [{ name: 'IPOH', zone: 'PERAK' }],
  areas: [{ id: 'far', name: 'Bintulu / Tatau', towns: ['BINTULU', 'TATAU'] }],
  rules: [
    { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 12_000 },
    { ruleType: 'POSITIONAL_TIER', tierPosition: 2, amountSen: 6_050 },
    { ruleType: 'POSITIONAL_TIER', tierPosition: 3, amountSen: 4_000 },
    { ruleType: 'OVERAGE', tierPosition: 5, amountSen: 2_500 },
    { ruleType: 'SOFA_BRACKET', bracketMin: 1, bracketMax: 3, amountSen: 5_000 },
    { ruleType: 'SOFA_BRACKET', bracketMin: 4, bracketMax: null, amountSen: 8_000 },
    { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 30_000, areaId: 'far' },
    { ruleType: 'OUTSTATION', zone: 'JOHOR', amountSen: 25_000 },
    { ruleType: 'OUTSTATION', zone: 'MELAKA', amountSen: 15_000 },
    { ruleType: 'OUTSTATION', zone: 'IPOH', amountSen: 9_000 },
    { ruleType: 'OUTSTATION_TRIP', zone: 'JOHOR', amountSen: 40_000 },
    { ruleType: 'DISPOSE', amountSen: 3_000 },
    { ruleType: 'SETUP', amountSen: 20_000 },
    { ruleType: 'DISMANTLE', amountSen: 18_000 },
    { ruleType: 'SERVICE', amountSen: 7_000 },
    { ruleType: 'PICKUP', amountSen: 6_000 },
    { ruleType: 'INSPECTION', amountSen: 5_500 },
    { ruleType: 'SUPPLIER_PICKUP', amountSen: 9_900 },
    { ruleType: 'TRANSFER', amountSen: 4_400 },
  ],
};

const SAMPLE_FACTS: Array<[string, DeliveryFacts, boolean]> = [
  ['one set in town', { setCount: 1 }, false],
  ['seven sets, two sofas, Johor by zone', { setCount: 7, sofaCompartments: [3, 6], destinationZone: 'JOHOR' }, false],
  ['trip Melaka + Johor stops', {
    setCount: 3,
    stops: [{ zone: 'MELAKA', addressText: 'Jalan Hang Tuah Melaka' }, { zone: 'JOHOR', addressText: 'Taman Molek Johor Bahru' }],
  }, true],
  ['Ipoh town by address in Perak', { setCount: 2, stops: [{ zone: 'PERAK', addressText: 'Jalan Sultan Idris Ipoh' }] }, false],
  ['area by address', { setCount: 2, addressText: 'Lot 5 Bintulu Sarawak' }, false],
  ['every charge once', {
    setCount: 1, disposeCount: 1, setupCount: 1, dismantleCount: 1, serviceCount: 1, pickupCount: 1,
    inspectionCount: 1, supplierPickupCount: 1, transferCount: 1, destinationZone: 'MELAKA',
  }, true],
  ['capped', { setCount: 40, setupCount: 5 }, false],
  ['nothing', {}, false],
];

/* The totals this card priced BEFORE job types and Applies to existed, read off
   the previous engine for the same facts. A card nobody has touched must keep
   pricing exactly these. */
const TOTALS_BEFORE: Record<string, number> = {
  'one set in town': 12_000,
  'seven sets, two sofas, Johor by zone': 73_100,
  'trip Melaka + Johor stops': 87_100,
  'Ipoh town by address in Perak': 27_100,
  'area by address': 60_000,
  'every charge once': 100_800,
  capped: 200_000,
  nothing: 8_000,
};

describe('an existing card prices as it did', () => {
  test.each(SAMPLE_FACTS)('%s', (name, facts, perTrip) => {
    expect(computeDeliveryCost(SAMPLE_CARD, facts, { perTrip }).totalSen).toBe(TOTALS_BEFORE[name]);
  });
  test('a stop with no job type is a delivery order', () => {
    const tagged: DeliveryFacts = { setCount: 1, stops: [{ zone: 'JOHOR', addressText: 'Johor Bahru', jobType: 'DELIVERY' }] };
    const untagged: DeliveryFacts = { setCount: 1, stops: [{ zone: 'JOHOR', addressText: 'Johor Bahru' }] };
    expect(computeDeliveryCost(SAMPLE_CARD, tagged, { perTrip: true }).totalSen)
      .toBe(computeDeliveryCost(SAMPLE_CARD, untagged, { perTrip: true }).totalSen);
  });
});

describe('every billable job type is priced by its rule', () => {
  test('the billable jobs are the dispatchable ones less the non-billable', () => {
    const expected = DISPATCHABLE_JOB_TYPES.filter((t) => !(NON_BILLABLE_JOB_TYPES as readonly string[]).includes(t));
    expect([...BILLABLE_JOB_TYPES].sort()).toEqual([...expected].sort());
  });
  const flat: Array<[string, keyof DeliveryFacts, number]> = [
    ['SETUP', 'setupCount', 20_000],
    ['DISMANTLE', 'dismantleCount', 18_000],
    ['SERVICE', 'serviceCount', 7_000],
    ['PICKUP', 'pickupCount', 6_000],
    ['INSPECTION', 'inspectionCount', 5_500],
    ['SUPPLIER_PICKUP', 'supplierPickupCount', 9_900],
    ['TRANSFER', 'transferCount', 4_400],
  ];
  test.each(flat)('%s x2 is twice its rule', (job, fact, each) => {
    const card: RateCardSpec = { ...SAMPLE_CARD, minChargeSen: null, rounding: 'NONE' };
    const b = computeDeliveryCost(card, { [fact]: 2 } as DeliveryFacts);
    expect(b.lines).toEqual([expect.objectContaining({ ruleType: job, amountSen: each * 2 })]);
    expect(RULE_JOB_TYPE[job as keyof typeof RULE_JOB_TYPE]).toBe(job);
  });
  test('a delivery order is priced by the ladder', () => {
    const card: RateCardSpec = { ...SAMPLE_CARD, minChargeSen: null, rounding: 'NONE' };
    expect(computeDeliveryCost(card, { setCount: 2 }).totalSen).toBe(18_050);
  });
});

describe('outstation Applies to', () => {
  const card: RateCardSpec = { ...SAMPLE_CARD, minChargeSen: null, rounding: 'NONE' };
  const setupInJohor: DeliveryFacts = { setupCount: 1, stops: [{ zone: 'JOHOR', addressText: 'Johor Bahru', jobType: 'SETUP' }] };
  const johorFor = (appliesTo: string[]): RateCardSpec => ({
    ...card,
    rules: card.rules.map((r) => (r.zone === 'JOHOR' ? { ...r, appliesTo } : r)),
  });

  test('by default it adds to delivery orders only', () => {
    expect(outstationApplies({}, null)).toBe(true);
    expect(outstationApplies({}, 'DELIVERY')).toBe(true);
    expect(outstationApplies({}, 'SETUP')).toBe(false);
    expect(computeDeliveryCost(card, setupInJohor, { perTrip: true }).totalSen).toBe(20_000);
  });

  test('a rule that names Setup adds to a setup in its zone, per order and per trip', () => {
    const b = computeDeliveryCost(johorFor(['DELIVERY', 'SETUP']), setupInJohor, { perTrip: true });
    expect(b.lines.map((l) => [l.ruleType, l.amountSen])).toEqual([
      ['OUTSTATION', 25_000], ['SETUP', 20_000], ['OUTSTATION_TRIP', 40_000],
    ]);
  });

  test('a rule only for Setup leaves a delivery order to the same zone alone', () => {
    const b = computeDeliveryCost(johorFor(['SETUP']), { setCount: 1, stops: [{ zone: 'JOHOR', addressText: 'Johor Bahru' }] }, { perTrip: true });
    expect(b.totalSen).toBe(12_000);
  });

  test('the job and the zone must be the same stop', () => {
    /* A delivery to Johor and a setup in Melaka: Johor's setup-only price is not reached by the setup. */
    const b = computeDeliveryCost(johorFor(['SETUP']), {
      setCount: 1, setupCount: 1,
      stops: [{ zone: 'JOHOR', addressText: 'Johor Bahru' }, { zone: 'MELAKA', addressText: 'Melaka', jobType: 'SETUP' }],
    });
    expect(b.lines.map((l) => l.ruleType)).toEqual(['POSITIONAL_TIER', 'SETUP']);
  });

  test('without stops the job named on the facts decides', () => {
    expect(computeDeliveryCost(card, { setupCount: 1, destinationZone: 'JOHOR', jobType: 'SETUP' }).totalSen).toBe(20_000);
    expect(computeDeliveryCost(card, { setupCount: 1, destinationZone: 'JOHOR' }).totalSen).toBe(45_000);
    expect(computeDeliveryCost(johorFor(['SETUP']), { setupCount: 1, destinationZone: 'JOHOR', jobType: 'SETUP' }).totalSen).toBe(45_000);
  });

  test('stored params read back to a clean list, the default when empty or unknown', () => {
    expect(appliesToOf(null)).toEqual(['DELIVERY']);
    expect(appliesToOf({ appliesTo: [] })).toEqual(['DELIVERY']);
    expect(appliesToOf({ appliesTo: ['bogus', 'LORRY_SERVICE'] })).toEqual(['DELIVERY']);
    expect(appliesToOf({ appliesTo: ['service', 'SETUP', 'SETUP'] })).toEqual(['SETUP', 'SERVICE']);
  });
});

describe('the other jobs on a trip (trip reconciliation)', () => {
  const row = (stopType: string, doId: string | null = null, assrCaseId: string | null = null) => ({ stopType, doId, assrCaseId, address: null });
  test('each stop is the job DP calls it', () => {
    expect(stopJob(row('DELIVERY', 'do-1'))).toBeNull();
    expect(stopJob(row('DELIVERY', null, '7'))).toBe('SERVICE');
    expect(stopJob(row('DELIVERY'))).toBeNull();
    expect(stopJob(row('LORRY_SERVICE'))).toBeNull();
    for (const job of Object.keys(JOB_COUNT_FACT)) expect(stopJob(row(job))).toBe(job);
  });
  test('counts and job-tagged addresses', () => {
    const out = jobStopFacts([
      { stopType: 'SETUP', doId: null, assrCaseId: null, address: 'Hall A 81100 Johor Bahru' },
      { stopType: 'SETUP', doId: null, assrCaseId: null, address: null },
      { stopType: 'PICKUP', doId: null, assrCaseId: '9', address: 'Taman X' },
      { stopType: 'DELIVERY', doId: 'do-1', assrCaseId: null, address: 'ignored' },
    ], (a) => (a && a.includes('81100') ? 'JOHOR' : null));
    expect(out.counts).toEqual({ setupCount: 2, pickupCount: 1 });
    expect(out.stops).toEqual([
      { zone: 'JOHOR', addressText: 'Hall A 81100 Johor Bahru', jobType: 'SETUP' },
      { zone: null, addressText: '', jobType: 'SETUP' },
      { zone: null, addressText: 'Taman X', jobType: 'PICKUP' },
    ]);
  });
});
