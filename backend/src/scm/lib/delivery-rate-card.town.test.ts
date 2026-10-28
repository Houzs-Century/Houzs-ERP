// HC-0031: 3PL quotes price outstation by TOWN (master rate xlsx: Rawang RM22.50,
// Seremban RM40, Johor Bahru RM250). Rawang and Kepong share postcode zone KL, so
// a postcode zone alone cannot price them; an OUTSTATION rule may name a town.
import { describe, expect, test } from 'vitest';
import { computeDeliveryCost, townsInAddress, type RateCardSpec } from './delivery-rate-card';

const card: RateCardSpec = {
  basis: 'SET',
  rules: [
    { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 14_500 },
    { ruleType: 'OUTSTATION', zone: 'RAWANG', amountSen: 2_250 },
    { ruleType: 'OUTSTATION', zone: 'JOHOR BAHRU', amountSen: 25_000 },
    { ruleType: 'OUTSTATION', zone: 'JOHOR', amountSen: 15_000 },
  ],
};

describe('town-named OUTSTATION rules', () => {
  test('a town in the address adds its surcharge', () => {
    const r = computeDeliveryCost(card, { setCount: 1, destinationZone: 'KL', addressText: 'No.16, Kota Emerald, Rawang 48000' });
    expect(r.totalSen).toBe(16_750);
  });

  test('the highest matching surcharge wins, charged once', () => {
    const r = computeDeliveryCost(card, { setCount: 1, destinationZone: 'JOHOR', addressText: 'Taman Molek, Johor Bahru' });
    expect(r.totalSen).toBe(14_500 + 25_000);
  });

  test('whole words only: "Rawangsa" is not Rawang; no address adds nothing', () => {
    expect(townsInAddress(card.rules, 'OUTSTATION', 'Jalan Rawangsa 2')).toEqual([]);
    expect(computeDeliveryCost(card, { setCount: 1, destinationZone: 'KL', addressText: null }).totalSen).toBe(14_500);
  });
});
