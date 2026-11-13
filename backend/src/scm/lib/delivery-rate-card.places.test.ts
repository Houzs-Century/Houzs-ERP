// Places under delivery zones (owner 2026-11-11: 3PL areas aligned with the
// Delivery Zones maintenance, 做). An order's zone comes from its postcode; a
// town a 3PL card names counts only inside the zone it belongs to, so a Kuala
// Lumpur street called Jalan Ipoh is not Ipoh. A card price that names a zone
// covers every order of that zone, spelled in the address or not. The amounts
// are made up.
import { describe, expect, test } from 'vitest';
import { areaOf, computeDeliveryCost, type RateCardSpec } from './delivery-rate-card';

const FAR = 'area-far';
const card: RateCardSpec = {
  basis: 'SET',
  places: [
    { name: 'IPOH', zone: 'PERAK' },
    { name: 'TAIPING', zone: 'PERAK' },
    { name: 'BRUNEI', zone: null },
  ],
  areas: [{ id: FAR, name: 'Far', towns: ['IPOH', 'JOHOR'] }],
  rules: [
    { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 10_000 },
    { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 0, areaId: FAR },
    { ruleType: 'OUTSTATION', zone: 'IPOH', amountSen: 50_000 },
    { ruleType: 'OUTSTATION', zone: 'TAIPING', amountSen: 60_000 },
    { ruleType: 'OUTSTATION', zone: 'JOHOR', amountSen: 70_000 },
    { ruleType: 'OUTSTATION', zone: 'MELAKA', amountSen: 40_000 },
    { ruleType: 'OUTSTATION', zone: 'KAPAR', amountSen: 2_000 },
    { ruleType: 'OUTSTATION', zone: 'BRUNEI', amountSen: 90_000 },
  ],
};

const outstation = (r: ReturnType<typeof computeDeliveryCost>) => r.lines.filter((l) => l.ruleType === 'OUTSTATION').map((l) => l.amountSen);

describe('a town counts only inside its own zone', () => {
  test('a Kuala Lumpur street named after Ipoh is not Ipoh', () => {
    const r = computeDeliveryCost(card, { setCount: 1, stops: [{ zone: 'KL', addressText: '12 Jalan Ipoh, 51200 Kuala Lumpur' }] });
    expect(outstation(r)).toEqual([]);
    expect(r.area).toBeNull();
    expect(r.totalSen).toBe(10_000);
  });

  test('Ipoh inside Perak is Ipoh: the area and the town price both apply', () => {
    const r = computeDeliveryCost(card, { setCount: 1, stops: [{ zone: 'PERAK', addressText: 'Taman Canning, 31400 Ipoh' }] });
    expect(r.area).toEqual({ id: FAR, name: 'Far' });
    expect(outstation(r)).toEqual([50_000]);
    expect(r.totalSen).toBe(50_000);
  });
});

describe('a price that names a zone covers the whole zone by postcode', () => {
  test('a Johor order whose address never spells Johor still takes the Johor price and area', () => {
    const r = computeDeliveryCost(card, { setCount: 2, stops: [{ zone: 'JOHOR', addressText: 'Taman Molek, 81100 JB' }] });
    expect(areaOf(card, { stops: [{ zone: 'JOHOR', addressText: 'Taman Molek, 81100 JB' }] })?.id).toBe(FAR);
    expect(outstation(r)).toEqual([70_000]);
    expect(r.totalSen).toBe(70_000);
  });

  test('a street called Jalan Johor in another zone does not', () => {
    const r = computeDeliveryCost(card, { setCount: 1, stops: [{ zone: 'KL', addressText: '3 Jalan Johor, 50000 Kuala Lumpur' }] });
    expect(outstation(r)).toEqual([]);
    expect(r.area).toBeNull();
  });
});

describe('when the zone cannot be told', () => {
  test('an order with no postcode is read by its words, as before', () => {
    const r = computeDeliveryCost(card, { setCount: 1, stops: [{ zone: null, addressText: 'Jalan Ipoh, Kuala Lumpur' }] });
    expect(outstation(r)).toEqual([50_000]);
  });

  test('a town not yet given a zone counts wherever it is spelled', () => {
    const r = computeDeliveryCost(card, { setCount: 1, stops: [{ zone: 'KLANG', addressText: 'Lot 5, Jalan Kapar, 42200 Kapar' }] });
    expect(outstation(r)).toEqual([2_000]);
  });

  test('a place with no zone (abroad) counts wherever it is spelled', () => {
    const r = computeDeliveryCost(card, { setCount: 1, stops: [{ zone: null, addressText: 'Kampong Kiarong, Brunei' }] });
    expect(outstation(r)).toEqual([90_000]);
  });
});

describe('a trip of several stops', () => {
  test('is charged once, for the dearest place it reaches', () => {
    const r = computeDeliveryCost(card, {
      setCount: 2,
      stops: [
        { zone: 'MELAKA', addressText: 'Taman Asean, 75250 Melaka' },
        { zone: 'PERAK', addressText: 'Jalan Kota, 34000 Taiping' },
        { zone: 'KL', addressText: 'Jalan Ipoh, 51200 Kuala Lumpur' },
      ],
    });
    expect(outstation(r)).toEqual([60_000]);
  });
});
