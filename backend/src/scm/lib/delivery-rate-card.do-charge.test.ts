/* A named charge on each delivery order (DO_CHARGE; owner 2026-11-24 on the
   Singapore carriers: 9% + 6% of the goods value, a RM 30 permit per order).
   Made-up figures. */
import { describe, expect, test } from 'vitest';
import { computeDeliveryCost, type RateCardSpec, type RateRuleSpec } from './delivery-rate-card';
import { doGoodsSen, orderGoodsSen } from './threepl-do-charge';

const sst: RateRuleSpec = { ruleType: 'DO_CHARGE', amountSen: 0, bps: 900, label: 'SST' };
const cost: RateRuleSpec = { ruleType: 'DO_CHARGE', amountSen: 0, bps: 600, label: 'Cost' };
const permit: RateRuleSpec = { ruleType: 'DO_CHARGE', amountSen: 3_000, bps: 0, label: 'Permit' };
const card = (rules: RateRuleSpec[], extra: Partial<RateCardSpec> = {}): RateCardSpec => ({ basis: 'SET', aggregation: 'UNIT', rules, ...extra });

describe('a charge on each delivery order', () => {
  test('one DO: 9% and 6% of its goods, and the permit, each its own line', () => {
    const b = computeDeliveryCost(card([sst, cost, permit]), { setCount: 2, dropCount: 1, goodsValueSen: 500_000 });
    expect(b.lines.map((l) => [l.label, l.amountSen])).toEqual([['SST 9% of goods', 45_000], ['Cost 6% of goods', 30_000], ['Permit', 3_000]]);
    expect(b.totalSen).toBe(78_000);
  });

  test('a trip: the share is of all its goods, the amount once per DO', () => {
    const b = computeDeliveryCost(card([sst, permit]), { dropCount: 3, goodsValueSen: 1_000_000 }, { perTrip: true });
    expect(b.lines.map((l) => [l.label, l.amountSen])).toEqual([['SST 9% of goods', 90_000], ['Permit x3', 9_000]]);
  });

  test('it rides with the set prices, inside the card cap', () => {
    const b = computeDeliveryCost(card([{ ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 5_000 }, sst], { capSen: 40_000 }), { setCount: 1, dropCount: 1, goodsValueSen: 500_000 });
    expect(b.subtotalSen).toBe(5_000 + 45_000);
    expect(b.totalSen).toBe(40_000);
  });

  test('no goods value read: only the amount per DO; nothing to charge: no line', () => {
    expect(computeDeliveryCost(card([sst, permit]), { dropCount: 1 }).lines.map((l) => l.label)).toEqual(['Permit']);
    expect(computeDeliveryCost(card([sst]), { dropCount: 0, goodsValueSen: 0 }).lines).toEqual([]);
  });
});

describe("a DO's goods value", () => {
  test("its order's goods by category, the service lines left out", () => {
    expect(orderGoodsSen({ mattress_sofa_sen: 300_000, bedframe_sen: 150_000, accessories_sen: 20_000, others_sen: 5_000, service_sen: 80_000 })).toBe(475_000);
    expect(orderGoodsSen({})).toBe(0);
  });

  test("an order out in two DOs: each DO's share of the order; a RM 0 follow-up DO carries none", () => {
    expect(doGoodsSen(475_000, 555_000, 555_000)).toBe(475_000);
    expect(doGoodsSen(475_000, 555_000, 0)).toBe(0);
    expect(doGoodsSen(400_000, 500_000, 250_000)).toBe(200_000);
    expect(doGoodsSen(400_000, 0, null)).toBe(400_000);
  });
});
