/* A named charge on each delivery order (DO_CHARGE; owner 2026-11-24 on the
   Singapore carriers: shares of the goods value, a permit per order).
   Made-up rates and figures throughout. */
import { describe, expect, test } from 'vitest';
import { computeDeliveryCost, type RateCardSpec, type RateRuleSpec } from './delivery-rate-card';
import { doGoodsSen } from './do-goods';

const tax: RateRuleSpec = { ruleType: 'DO_CHARGE', amountSen: 0, bps: 700, label: 'Tax' };
const fee: RateRuleSpec = { ruleType: 'DO_CHARGE', amountSen: 0, bps: 500, label: 'Fee' };
const permit: RateRuleSpec = { ruleType: 'DO_CHARGE', amountSen: 2_500, bps: 0, label: 'Permit' };
const card = (rules: RateRuleSpec[], extra: Partial<RateCardSpec> = {}): RateCardSpec => ({ basis: 'SET', aggregation: 'UNIT', rules, ...extra });

describe('a charge on each delivery order', () => {
  test('one DO: each share of its goods and the fixed charge, each its own line', () => {
    const b = computeDeliveryCost(card([tax, fee, permit]), { setCount: 2, dropCount: 1, goodsValueSen: 500_000 });
    expect(b.lines.map((l) => [l.label, l.amountSen])).toEqual([['Tax 7% of goods', 35_000], ['Fee 5% of goods', 25_000], ['Permit', 2_500]]);
    expect(b.totalSen).toBe(62_500);
  });

  test('a trip: the share is of all its goods, the fixed charge once per DO', () => {
    const b = computeDeliveryCost(card([tax, permit]), { dropCount: 3, goodsValueSen: 1_000_000 }, { perTrip: true });
    expect(b.lines.map((l) => [l.label, l.amountSen])).toEqual([['Tax 7% of goods', 70_000], ['Permit x3', 7_500]]);
  });

  test('it rides with the set prices, inside the card cap', () => {
    const b = computeDeliveryCost(card([{ ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 5_000 }, tax], { capSen: 30_000 }), { setCount: 1, dropCount: 1, goodsValueSen: 500_000 });
    expect(b.subtotalSen).toBe(5_000 + 35_000);
    expect(b.totalSen).toBe(30_000);
  });

  test('no goods value read: only the fixed charge; nothing to charge: no line', () => {
    expect(computeDeliveryCost(card([tax, permit]), { dropCount: 1 }).lines.map((l) => l.label)).toEqual(['Permit']);
    expect(computeDeliveryCost(card([tax]), { dropCount: 0, goodsValueSen: 0 }).lines).toEqual([]);
  });
});

describe("a DO's goods value", () => {
  test('its own lines without the service ones, by group or by service code', () => {
    expect(doGoodsSen([
      { item_group: 'BEDFRAME', item_code: 'TEST-BF', line_total_sen: 300_000 },
      { item_group: 'Mattress', item_code: 'TEST-MT', line_total_sen: 150_000 },
      { item_group: 'SERVICE', item_code: 'TEST-LIFT', line_total_sen: 40_000 },
      { item_group: null, item_code: 'SVC-DELIVERY', line_total_sen: 20_000 },
    ])).toBe(450_000);
  });

  test('a follow-up DO of RM 0 carries none; no lines is none', () => {
    expect(doGoodsSen([{ item_group: 'BEDFRAME', item_code: 'TEST-BF', line_total_sen: 0 }])).toBe(0);
    expect(doGoodsSen([])).toBe(0);
  });
});
